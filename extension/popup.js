const identity = document.querySelector('#identity');
const host = document.querySelector('#host');
const result = document.querySelector('#result');
const connect = document.querySelector('#connect');
const collectNow = document.querySelector('#collect-now');
const daily = document.querySelector('#daily');
const choices = [...document.querySelectorAll('[name="capture-kind"]')];

function selectedKinds() {
  return choices.filter(({ checked }) => checked).map(({ value }) => value);
}

function refreshButtons() {
  connect.disabled = selectedKinds().length === 0;
}

async function send(message) {
  result.textContent = 'Working…';
  const response = await chrome.runtime.sendMessage(message);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

async function load() {
  try {
    const state = await send({ type: 'get-state' });
    identity.textContent = state.handle ? `${state.platform.toUpperCase()} · @${state.handle}` : 'Signed-in account not detected';
    host.textContent = state.hostReady ? 'Local bridge ready' : 'Local bridge missing — run the install-host command';
    host.classList.toggle('error', !state.hostReady);
    for (const choice of choices) choice.checked = state.settings?.selectedCaptureKinds?.includes(choice.value) ?? choice.value === 'save';
    daily.checked = state.daily;
    collectNow.disabled = !state.settings?.connected;
    result.textContent = state.settings?.connected ? 'This Chrome profile is connected.' : 'Choose what to collect, then connect.';
    refreshButtons();
  } catch (error) {
    identity.textContent = 'Open X or Threads first';
    host.textContent = error.message;
    host.classList.add('error');
    connect.disabled = true;
    collectNow.disabled = true;
    result.textContent = '';
  }
}

for (const choice of choices) choice.addEventListener('change', refreshButtons);
connect.addEventListener('click', async () => {
  try {
    await send({ type: 'connect', selectedCaptureKinds: selectedKinds() });
    collectNow.disabled = false;
    result.textContent = 'Connected. Your handle was detected automatically.';
  } catch (error) { result.textContent = error.message; }
});
collectNow.addEventListener('click', async () => {
  try {
    const summary = await send({ type: 'collect-now' });
    result.textContent = `Collected ${summary.items} item${summary.items === 1 ? '' : 's'}.`;
  } catch (error) { result.textContent = error.message; }
});
daily.addEventListener('change', async () => {
  try {
    await send({ type: 'set-daily', enabled: daily.checked });
    result.textContent = daily.checked ? 'Daily collection enabled.' : 'Daily collection disabled.';
  } catch (error) { result.textContent = error.message; }
});

void load();
