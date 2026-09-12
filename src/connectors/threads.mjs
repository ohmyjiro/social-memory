import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MARKER = 'SOCIAL_MEMORY_JSON:';
const SURFACE_BY_KIND = Object.freeze({ like: 'likes', save: 'saved', repost: 'reposts' });
const LANDMARK_BY_SURFACE = Object.freeze({
  likes: 'like_state',
  saved: 'saved_surface',
  reposts: 'reposts_tab',
});
const NATIVE_KIND = Object.freeze({ like: 'like', save: 'saved', repost: 'repost' });

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireProfileRef(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('Threads profile reference must use only letters, numbers, dot, underscore, or hyphen');
  }
  return value;
}

export function parseAsideBridgeOutput(output) {
  const plain = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = plain.split(/\r?\n/).filter((line) => line.includes(MARKER));
  if (lines.length !== 1) {
    throw connectorError('bridge_output', 'Aside bridge requires exactly one JSON marker');
  }
  const payload = lines[0].slice(lines[0].indexOf(MARKER) + MARKER.length);
  try {
    return JSON.parse(payload);
  } catch {
    throw connectorError('bridge_output', 'Aside bridge returned invalid JSON');
  }
}

function identityScript() {
  return `const tabs=await listBrowserTabs();const tab=tabs.find(t=>t.url.includes('threads.com'));if(!tab)throw new Error('Threads tab unavailable');const page=await attachBrowserTab(tab.targetId);await snapshot(page,{interactive:true});const link=await page.getByRole('link',{name:'프로필',exact:true}).getAttribute('href');const handle=link&&link.split('/@')[1]?.split('/')[0];const profileUrl=link?(link.startsWith('http')?link:'https://www.threads.com'+link):null;console.log('${MARKER}'+JSON.stringify({handle:handle||null,profileUrl,landmarks:['profile_link']}));`;
}

export function observedThreadsLandmarks({ surface, tree, itemCount, url }) {
  const expected = {
    likes: 'like_state',
    saved: 'saved_surface',
    reposts: 'reposts_tab',
  }[surface];
  const routeMatches = surface === 'likes'
    ? url.includes('/liked')
    : surface === 'saved'
      ? url.includes('/saved')
      : url.includes('/reposts');
  const headingMatches = surface === 'likes'
    ? /(?:"좋아요"|"Liked")/.test(tree)
    : surface === 'saved'
      ? /(?:"저장됨"|"Saved")/.test(tree)
      : /(?:link "리포스트"|link "Reposts")/.test(tree);
  if (!expected || !routeMatches || !headingMatches) return [];
  const landmarks = [expected];
  if (itemCount > 0) landmarks.push('post_permalink');
  else if (/저장한 게시물이 여기에 표시됩니다|saved posts will appear here/i.test(tree)) {
    landmarks.push('empty_state');
  }
  return landmarks;
}

function surfaceScript(surface, limit) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  return `
const tabs=await listBrowserTabs();
const tab=tabs.find(t=>t.url.includes('threads.com'));
if(!tab)throw new Error('Threads tab unavailable');
const current=await attachBrowserTab(tab.targetId);
await snapshot(current,{interactive:true});
const profileHref=await current.getByRole('link',{name:'프로필',exact:true}).getAttribute('href');
const surface=${JSON.stringify(surface)};
const target=surface==='likes'?'https://www.threads.com/liked/':surface==='saved'?'https://www.threads.com/saved/':'https://www.threads.com'+profileHref+'/reposts';
const page=await openTab(target);
const items=new Map();
let tree='';
const detect=${observedThreadsLandmarks.toString()};
const parseDate=(label)=>{const m=label.match(/(\\d{4})년 (\\d{1,2})월 (\\d{1,2})일 .* (오전|오후) (\\d{1,2}):(\\d{2})/);if(!m)return null;let h=Number(m[5]);if(m[4]==='오후'&&h<12)h+=12;if(m[4]==='오전'&&h===12)h=0;return new Date(m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')+'T'+String(h).padStart(2,'0')+':'+m[6]+':00+09:00').toISOString();};
for(let round=0;round<8&&items.size<${boundedLimit};round++){
  const shot=await snapshot(page,{interactive:true});tree=shot.tree;
  const chunks=tree.match(/(?:^|\\n)  - generic \\[ref=[\\s\\S]*?(?=\\n  - generic \\[ref=|$)/g)||[tree];
  for(const chunk of chunks){
    const links=[...chunk.matchAll(/link \"((?:\\\\.|[^\"])*)\" \\[ref=(e\\d+)\\]/g)];
    let sourceUrl=null;let dateLabel=null;
    for(const match of links){const href=await page.locator(match[2]).getAttribute('href').catch(()=>null);if(href&&href.includes('/post/')){sourceUrl=href.startsWith('http')?href:'https://www.threads.com'+href;dateLabel=match[1];break;}}
    if(!sourceUrl)continue;
    const pathOnly=sourceUrl.startsWith('https://www.threads.com')?sourceUrl.slice('https://www.threads.com'.length):sourceUrl;const parts=pathOnly.split('/');const at=parts.findIndex(part=>part.startsWith('@'));const post=parts.indexOf('post');
    if(at<0||post<0||!parts[post+1])continue;
    const postId=parts[post+1];const texts=[...chunk.matchAll(/- text: \"((?:\\\\.|[^\"])*)\"/g)].map(m=>{try{return JSON.parse('\"'+m[1]+'\"')}catch{return m[1]}}).sort((a,b)=>b.length-a.length);
    const assets=[];for(const m of chunk.matchAll(/(?:link|button) \"(Photo by (?:\\\\.|[^\"])*)\"/g))assets.push({kind:'image',sourceUrl:sourceUrl+'/media',altText:m[1]});if(chunk.includes('Video player'))assets.push({kind:'video',sourceUrl,altText:null});
    items.set(postId,{postId,sourceUrl,authorHandle:parts[at].slice(1),authorName:null,text:texts[0]||'',postedAt:parseDate(dateLabel),assets});
    if(items.size>=${boundedLimit})break;
  }
  if(round<7&&items.size<${boundedLimit}){await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await sleep(700);}
}
const landmarks=detect({surface,tree,itemCount:items.size,url:page.url()});
console.log('${MARKER}'+JSON.stringify({items:[...items.values()],cursor:null,landmarks,exhausted:!tree.includes('읽어들이는 중')}));
await closeTab(page);`;
}

async function runAside(profileRef, code, execFileImpl) {
  requireProfileRef(profileRef);
  const { stdout = '', stderr = '' } = await execFileImpl(
    'aside',
    ['repl', '--account', profileRef, code],
    { maxBuffer: 20 * 1024 * 1024, timeout: 120_000, shell: false },
  );
  return parseAsideBridgeOutput(`${stdout}\n${stderr}`);
}

export function createAsideThreadsBridge({ execFileImpl = execFile } = {}) {
  return Object.freeze({
    inspectIdentity({ profileRef }) {
      return runAside(profileRef, identityScript(), execFileImpl);
    },
    readSurface({ profileRef, surface, limit }) {
      if (!LANDMARK_BY_SURFACE[surface]) {
        throw connectorError('invalid_surface', `Unknown Threads surface: ${surface}`);
      }
      return runAside(profileRef, surfaceScript(surface, limit), execFileImpl);
    },
  });
}

function mapItem(item, kind) {
  if (!item?.postId || !item?.sourceUrl) {
    throw connectorError('connector_drift', 'Threads item is missing its post identity');
  }
  const evidence = [];
  for (const asset of item.assets ?? []) {
    if (asset.altText) {
      evidence.push({ kind: 'text', text: asset.altText, provenance: 'threads-media-alt-text' });
    }
    if (asset.sourceUrl) {
      evidence.push({
        kind: 'text',
        text: `${asset.kind ?? 'media'}: ${asset.sourceUrl}`,
        sourceUrl: asset.sourceUrl,
        provenance: 'threads-media-metadata',
      });
    }
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

export function createThreadsConnector({ browserBridge = createAsideThreadsBridge() } = {}) {
  return Object.freeze({
    id: 'threads',
    capabilities: Object.freeze(['like', 'save', 'repost']),
    normalizeProfileRef: requireProfileRef,
    normalizeConfig(value) {
      const key = Object.keys(value)[0];
      if (key) throw new Error(`Unknown Threads connector config field: ${key}`);
      return {};
    },
    async verify({ account }) {
      const identity = await browserBridge.inspectIdentity({ profileRef: requireProfileRef(account.profileRef) });
      if (!identity?.handle) {
        throw connectorError('reauth_required', 'Threads authenticated identity is unavailable');
      }
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: identity.handle,
        connectorState: { profileUrl: identity.profileUrl ?? null },
      };
    },
    async collect({ account, kind, cursor, limit }) {
      const surface = SURFACE_BY_KIND[kind];
      if (!surface) throw connectorError('invalid_capture_kind', `Unsupported Threads capture kind: ${kind}`);
      const result = await browserBridge.readSurface({
        profileRef: requireProfileRef(account.profileRef),
        surface,
        cursor,
        limit,
      });
      if (!result || !Array.isArray(result.items) || !Array.isArray(result.landmarks)) {
        throw connectorError('connector_drift', 'Threads bridge response is incomplete');
      }
      const landmarks = new Set(result.landmarks);
      if (
        !landmarks.has(LANDMARK_BY_SURFACE[surface]) ||
        (!landmarks.has('post_permalink') && !landmarks.has('empty_state'))
      ) {
        throw connectorError('connector_drift', `Threads ${surface} UI landmarks changed`);
      }
      return {
        events: result.items.map((candidate) => mapItem(candidate, kind)),
        nextCursor: result.cursor ?? null,
      };
    },
  });
}

export const threadsConnector = createThreadsConnector();
