"""
Builds handout.pdf, the PDF fixture for the PDF importer: three pages, written by hand
(no PDF library) in the plainest valid form.

  page 1   960 x 540 pt (16:9), a title and a line of text
  page 2   960 x 540 pt, a filled rectangle
  page 3   612 x 792 pt (US Letter, portrait), so the importer meets a page of another shape

Run:  python3 build_pdf.py
"""
import os

PAGES = [
    (960, 540, 'BT /F1 48 Tf 80 400 Td (Quarterly review) Tj ET BT /F1 24 Tf 80 340 Td (Handout, page one) Tj ET'),
    (960, 540, '0.2 0.4 0.8 rg 80 120 400 300 re f BT /F1 24 Tf 520 300 Td (A blue box) Tj ET'),
    (612, 792, 'BT /F1 36 Tf 72 700 Td (Appendix) Tj ET BT /F1 18 Tf 72 650 Td (A portrait page.) Tj ET'),
]


def build() -> bytes:
    objects = []  # bodies, 1-based object numbers
    objects.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    kids = ' '.join(f'{4 + 2 * i} 0 R' for i in range(len(PAGES)))
    objects.append(f'<< /Type /Pages /Kids [{kids}] /Count {len(PAGES)} >>'.encode())
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')  # object 3
    for i, (w, h, content) in enumerate(PAGES):
        page_no = 4 + 2 * i
        objects.append(
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Contents {page_no + 1} 0 R '
            f'/Resources << /Font << /F1 3 0 R >> >> >>'.encode()
        )
        stream = content.encode()
        objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')

    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
    return bytes(out)


if __name__ == '__main__':
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'handout.pdf')
    with open(path, 'wb') as f:
        f.write(build())
    print('wrote', path)
