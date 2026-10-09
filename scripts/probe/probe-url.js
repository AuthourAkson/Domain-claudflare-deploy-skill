(() => JSON.stringify({
  url: location.href,
  hash: location.hash,
  title: document.title,
  text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260),
}))()
