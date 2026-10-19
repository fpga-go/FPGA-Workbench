'use strict';
const fs = require('node:fs/promises');
function decode(buffer, encoding = 'auto') {
  if (encoding !== 'auto') return new TextDecoder(encoding).decode(buffer);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  try { return new TextDecoder('utf-8', {fatal:true}).decode(buffer); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}
async function readSource(file, encoding) { return decode(await fs.readFile(file), encoding); }
module.exports = {decode, readSource};
