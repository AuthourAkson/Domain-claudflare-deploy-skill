(() => {
  const els = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"]')];
  const out = els.map((e, i) => ({
    i,
    tag: e.tagName.toLowerCase(),
    text: (e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 44),
    href: e.getAttribute('href') || '',
    id: e.id || '',
  })).filter(x => x.text || x.href);
  return JSON.stringify(out, null, 0);
})()
