import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MARKER = 'SOCIAL_MEMORY_JSON:';
const SURFACE_BY_KIND = Object.freeze({ like: 'likes', save: 'bookmarks', repost: 'reposts' });
const NATIVE_KIND = Object.freeze({ like: 'like', save: 'bookmark', repost: 'repost' });

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireProfileRef(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('X browser profile reference must use only letters, numbers, dot, underscore, or hyphen');
  }
  return value;
}

export function parseAsideXOutput(output) {
  const plain = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = plain.split(/\r?\n/).filter((line) => line.includes(MARKER));
  if (lines.length !== 1) {
    throw connectorError('bridge_output', 'X Aside bridge requires exactly one JSON marker');
  }
  try {
    return JSON.parse(lines[0].slice(lines[0].indexOf(MARKER) + MARKER.length));
  } catch {
    throw connectorError('bridge_output', 'X Aside bridge returned invalid JSON');
  }
}

async function runAside(profileRef, code, execFileImpl) {
  requireProfileRef(profileRef);
  try {
    const { stdout = '', stderr = '' } = await execFileImpl(
      'aside',
      ['repl', '--account', profileRef, code],
      { maxBuffer: 20 * 1024 * 1024, timeout: 120_000, shell: false },
    );
    return parseAsideXOutput(`${stdout}\n${stderr}`);
  } catch (error) {
    if (error?.code && typeof error.code === 'string' && error.code.includes('_')) throw error;
    throw connectorError('bridge_unavailable', 'X Aside bridge is unavailable');
  }
}

function identityScript() {
  return `const identity=await twitter.getMe();console.log('${MARKER}'+JSON.stringify({handle:identity.screenName||null,name:identity.name||null}));`;
}

function bookmarksScript(cursor, limit) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
  return `const result=await twitter.getBookmarks({count:${boundedLimit},cursor:${JSON.stringify(cursor ?? null)}});const items=(result.tweets||[]).map(tweet=>({postId:tweet.id,sourceUrl:'https://x.com/'+tweet.author.screenName+'/status/'+tweet.id,authorHandle:tweet.author.screenName,authorName:tweet.author.name||null,text:tweet.text||'',postedAt:tweet.createdAt||null,assets:(tweet.media||[]).map(media=>({kind:media.type==='photo'?'image':media.type,sourceUrl:media.url,altText:null}))}));console.log('${MARKER}'+JSON.stringify({items,cursor:result.nextCursor||null,landmarks:['bookmarks_api',items.length?'post_identity':'empty_state'],exhausted:!result.nextCursor}));`;
}

export function parseXDateLabel(label, nowMs = Date.now()) {
  let match = String(label).match(/(\d+)분 전/);
  if (match) return new Date(nowMs - Number(match[1]) * 60_000).toISOString();
  match = String(label).match(/(\d+)시간 전/);
  if (match) return new Date(nowMs - Number(match[1]) * 3_600_000).toISOString();
  match = String(label).match(/(\d+)월 (\d+)일/);
  if (!match) return null;
  const now = new Date(nowMs);
  let year = now.getFullYear();
  let candidate = new Date(`${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}T00:00:00+09:00`);
  if (candidate.valueOf() > nowMs + 86_400_000) {
    year -= 1;
    candidate = new Date(`${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}T00:00:00+09:00`);
  }
  return candidate.toISOString();
}

export function observedXLandmarks({ surface, tree, itemCount, url }) {
  const expected = surface === 'likes' ? 'likes_state' : surface === 'reposts' ? 'reposts_state' : null;
  if (!expected || !url.includes(`/${surface}`) || /로그인|Sign in to X/i.test(tree)) return [];
  const landmarks = [expected];
  if (itemCount > 0) landmarks.push('post_permalink');
  else if (/아직.*게시물|No .* yet|doesn.t have any/i.test(tree)) landmarks.push('empty_state');
  return landmarks;
}

function timelineScript(surface, handle, limit) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const route = `https://x.com/${handle}/${surface}`;
  return `
const page=await openTab(${JSON.stringify(route)});
const items=new Map();let tree='';
const parseDate=${parseXDateLabel.toString()};
const detect=${observedXLandmarks.toString()};
for(let round=0;round<8&&items.size<${boundedLimit};round++){
  const shot=await snapshot(page,{interactive:true});tree=shot.tree;
  const chunks=tree.match(/(?:^|\\n)\\s+- article [\\s\\S]*?(?=\\n\\s+- article |$)/g)||[tree];
  for(const chunk of chunks){
    const links=[...chunk.matchAll(/link \"((?:\\\\.|[^\"])*)\" \\[ref=(e\\d+)\\]/g)];let sourceUrl=null;let dateLabel='';
    for(const match of links){const href=await page.locator(match[2]).getAttribute('href').catch(()=>null);if(href&&href.includes('/status/')){sourceUrl=href.startsWith('http')?href:'https://x.com'+href;dateLabel=match[1];break;}}
    if(!sourceUrl)continue;const pathOnly=sourceUrl.startsWith('https://x.com')?sourceUrl.slice(13):sourceUrl;const parts=pathOnly.split('/');const statusIndex=parts.indexOf('status');if(statusIndex<1||!parts[statusIndex+1])continue;
    const texts=[...chunk.matchAll(/- text: \"((?:\\\\.|[^\"])*)\"/g)].map(m=>{try{return JSON.parse('\"'+m[1]+'\"')}catch{return m[1]}}).filter(text=>!text.startsWith('@')).sort((a,b)=>b.length-a.length);
    const assets=[];if(chunk.includes('동영상 재생')||chunk.includes('Play video'))assets.push({kind:'video',sourceUrl,altText:null});
    const postId=parts[statusIndex+1];items.set(postId,{postId,sourceUrl,authorHandle:parts[statusIndex-1],authorName:null,text:texts[0]||'',postedAt:parseDate(dateLabel),assets});if(items.size>=${boundedLimit})break;
  }
  if(round<7&&items.size<${boundedLimit}){await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await sleep(700);}
}
const landmarks=detect({surface:${JSON.stringify(surface)},tree,itemCount:items.size,url:page.url()});console.log('${MARKER}'+JSON.stringify({items:[...items.values()],cursor:null,landmarks,exhausted:!tree.includes('읽어들이는 중')}));await closeTab(page);`;
}

export function createAsideXBridge({ execFileImpl = execFile } = {}) {
  return Object.freeze({
    inspectIdentity({ profileRef }) {
      return runAside(profileRef, identityScript(), execFileImpl);
    },
    readSurface({ profileRef, surface, handle, cursor, limit }) {
      if (surface === 'bookmarks') {
        return runAside(profileRef, bookmarksScript(cursor, limit), execFileImpl);
      }
      if (!['likes', 'reposts'].includes(surface)) {
        throw connectorError('invalid_surface', `Unknown X Aside surface: ${surface}`);
      }
      return runAside(profileRef, timelineScript(surface, handle, limit), execFileImpl);
    },
  });
}

function mapItem(item, kind) {
  if (!item?.postId || !item?.sourceUrl) {
    throw connectorError('connector_drift', 'X Aside item is missing its post identity');
  }
  const evidence = [];
  for (const asset of item.assets ?? []) {
    if (asset.altText) evidence.push({ kind: 'text', text: asset.altText, provenance: 'x-media-alt-text' });
    if (asset.sourceUrl) evidence.push({
      kind: 'text',
      text: `${asset.kind ?? 'media'}: ${asset.sourceUrl}`,
      sourceUrl: asset.sourceUrl,
      provenance: 'x-media-metadata',
    });
  }
  return {
    externalId: item.postId,
    canonicalUrl: item.sourceUrl,
    author: { handle: item.authorHandle ?? null, name: item.authorName ?? null },
    text: item.text ?? null,
    sourceCreatedAt: item.postedAt ?? null,
    capture: { kind, nativeKind: NATIVE_KIND[kind], capturedAt: null },
    evidence,
    raw: { item },
  };
}

export function createXAsideConnector({
  id = 'x-aside',
  browserBridge = createAsideXBridge(),
  bookmarkLandmark = 'bookmarks_api',
  bookmarkItemLandmark = 'post_identity',
} = {}) {
  return Object.freeze({
    id,
    capabilities: Object.freeze(['like', 'save', 'repost']),
    normalizeProfileRef: requireProfileRef,
    normalizeConfig(value) {
      const key = Object.keys(value)[0];
      if (key) throw new Error(`Unknown X Aside connector config field: ${key}`);
      return {};
    },
    async verify({ account }) {
      const identity = await browserBridge.inspectIdentity({ profileRef: requireProfileRef(account.profileRef) });
      if (!identity?.handle) throw connectorError('reauth_required', 'X authenticated identity is unavailable');
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: identity.handle,
      };
    },
    async collect({ account, kind, cursor, limit, verification }) {
      const surface = SURFACE_BY_KIND[kind];
      if (!surface) throw connectorError('invalid_capture_kind', `Unsupported X Aside capture kind: ${kind}`);
      const result = await browserBridge.readSurface({
        profileRef: requireProfileRef(account.profileRef),
        surface,
        handle: verification?.authenticatedIdentity,
        cursor,
        limit,
      });
      if (!result || !Array.isArray(result.items) || !Array.isArray(result.landmarks)) {
        throw connectorError('connector_drift', 'X Aside bridge response is incomplete');
      }
      const landmarks = new Set(result.landmarks);
      const surfaceLandmark = surface === 'bookmarks' ? bookmarkLandmark : `${surface}_state`;
      const itemLandmark = surface === 'bookmarks' ? bookmarkItemLandmark : 'post_permalink';
      if (!landmarks.has(surfaceLandmark) || (!landmarks.has(itemLandmark) && !landmarks.has('empty_state'))) {
        throw connectorError('connector_drift', `X ${surface} landmarks changed`);
      }
      return {
        events: result.items.map((candidate) => mapItem(candidate, kind)),
        nextCursor: result.cursor ?? null,
      };
    },
  });
}

export const xAsideConnector = createXAsideConnector();
