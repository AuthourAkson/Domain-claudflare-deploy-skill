(() => {
  const inputs = [...document.querySelectorAll('input,select,textarea,[role="radio"],[role="checkbox"],[role="combobox"]')];
  return JSON.stringify(inputs.map((e, i) => ({
    i,
    tag: e.tagName.toLowerCase(),
    type: e.type || '',
    name: e.name || '',
    id: e.id || '',
    role: e.getAttribute('role') || '',
    placeholder: e.placeholder || '',
    value: (e.value || '').toString().slice(0, 30),
    checked: e.checked === undefined ? null : e.checked,
    state: e.getAttribute('data-state') || e.getAttribute('aria-checked') || '',
    label: ((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 46),
    text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30),
  })), null, 0);
})()
