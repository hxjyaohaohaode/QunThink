import AdmZip from 'adm-zip';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Small synthetic documents only. No downloaded/private fixtures or ZIP bombs.
export function docxFixture(text = '', { omitDocument = false, styleMarker = null, bodyXml = null } = {}) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  if (!omitDocument) {
    const body = bodyXml ?? `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`));
  }
  if (styleMarker) {
    zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="${WORD_NAMESPACE}"><w:style w:type="__proto__" w:styleId="${escapeXml(styleMarker)}"><w:name w:val="Harmless regression marker"/></w:style></w:styles>`));
  }
  return zip.toBuffer();
}
