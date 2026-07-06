// Извлечение текста из .docx без зависимостей: docx - это zip,
// текст лежит в word/document.xml. Читаем local file headers напрямую
// и распаковываем нужный файл через node:zlib.

import { inflateRawSync } from 'node:zlib';

const LOCAL_HEADER = 0x04034b50;

export function extractDocxText(buf) {
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== LOCAL_HEADER) break;
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;

    // streaming-запись без размера в заголовке - в docx не встречается,
    // но на всякий случай не читаем мусор
    if (flags & 0x08 && compSize === 0) break;

    if (name === 'word/document.xml') {
      const data = buf.slice(dataStart, dataStart + compSize);
      const xml = method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8');
      return xmlToText(xml);
    }
    i = dataStart + compSize;
  }
  return null;
}

function xmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
