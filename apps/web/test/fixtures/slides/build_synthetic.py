"""
Builds the hand-assembled fixtures of the import corpus:

  google-slides-export.pptx   what Google Slides writes: a 10 x 5.625 in page, uppercase layout
                              names, explicit geometry on every placeholder, Arial everywhere,
                              literal RGB colors, notes.
  keynote-export.pptx         what Keynote writes: groups with child transforms, rotated text
                              boxes, freeform (custom geometry) shapes, an EMF picture, a chart
                              with no preview, a link to another slide, autofit.
  libreoffice-impress.pptx    what LibreOffice writes: a theme-referenced gradient background,
                              a transition inside mc:AlternateContent, one blank master layout,
                              video from the package, a bulleted outline.
  libreoffice-impress.odp     OpenDocument Presentation: styles, a list, a table, a picture,
                              notes, a hidden slide, a transition, an animation.

None of these comes from the real applications (none was available to build the corpus);
they follow the structure those writers produce, field for field where it matters to a
reader, and are kept small so a failing assertion is easy to read.

Run:  python3 build_synthetic.py
"""
import struct
import zipfile
import zlib

A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
NS = f'xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}"'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'


def png(w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def rels(items):
    body = ''.join(
        f'<Relationship Id="{i}" Type="{REL}{t}" Target="{target}"' + (' TargetMode="External"' if ext else '') + '/>'
        for i, t, target, ext in items
    )
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>'


def theme_xml(name, major, minor, colors):
    names = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
    scheme = ''.join(f'<a:{n}><a:srgbClr val="{c}"/></a:{n}>' for n, c in zip(names, colors))
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="{A}" name="{name}"><a:themeElements>'
        f'<a:clrScheme name="{name}">{scheme}</a:clrScheme>'
        f'<a:fontScheme name="{name}"><a:majorFont><a:latin typeface="{major}"/></a:majorFont><a:minorFont><a:latin typeface="{minor}"/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="x"/></a:themeElements></a:theme>'
    )


def xfrm(x, y, w, h, extra=''):
    return f'<a:xfrm{extra}><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'


def ph_sp(id_, name, type_, idx, geom=None, body='', lst='', bodypr='<a:bodyPr/>'):
    ph = f'<p:ph type="{type_}"' + (f' idx="{idx}"' if idx is not None else '') + '/>'
    sppr = f'<p:spPr>{geom}</p:spPr>' if geom else '<p:spPr/>'
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{id_}" name="{name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>{ph}</p:nvPr></p:nvSpPr>'
        f'{sppr}<p:txBody>{bodypr}<a:lstStyle>{lst}</a:lstStyle>{body}</p:txBody></p:sp>'
    )


def para(text, ppr='', rpr=''):
    return f'<a:p>{ppr}<a:r>{rpr}<a:t>{text}</a:t></a:r></a:p>'


def sp(id_, name, geom_xml, prst='rect', fill='', ln='', body='', txbox=False, bodypr='<a:bodyPr/>', xf_extra=''):
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{id_}" name="{name}"/><p:cNvSpPr' + (' txBox="1"' if txbox else '') + '/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr>{geom_xml}' + (f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>' if prst else '') + f'{fill}{ln}</p:spPr>'
        + (f'<p:txBody>{bodypr}<a:lstStyle/>{body}</p:txBody>' if body else '')
        + '</p:sp>'
    )


def solid(rgb):
    return f'<a:solidFill><a:srgbClr val="{rgb}"/></a:solidFill>'


def pic(id_, name, rid, x, y, w, h, descr=''):
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{id_}" name="{name}" descr="{descr}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def slide_xml(shapes, bg='', extra='', show=None):
    attrs = f' show="{show}"' if show is not None else ''
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}{attrs}><p:cSld>{bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        f'<p:grpSpPr/>{shapes}</p:spTree></p:cSld>{extra}</p:sld>'
    )


def notes_xml(lines):
    paras = ''.join(f'<a:p><a:r><a:t>{l}</a:t></a:r></a:p>' for l in lines)
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
        f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>{paras}</p:txBody></p:sp>'
        '</p:spTree></p:cSld></p:notes>'
    )


def master_xml(shapes, bg, title_style, body_style, layout_count, clrmap='bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"'):
    ids = ''.join(f'<p:sldLayoutId id="{2147483649 + i}" r:id="rId{i + 1}"/>' for i in range(layout_count))
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {NS}><p:cSld name="Master">{bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld>'
        f'<p:clrMap {clrmap} accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
        f'<p:sldLayoutIdLst>{ids}</p:sldLayoutIdLst>'
        f'<p:txStyles><p:titleStyle>{title_style}</p:titleStyle><p:bodyStyle>{body_style}</p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>'
    )


def layout_xml(name, type_, shapes, attrs='', bg=''):
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {NS} type="{type_}"{attrs}><p:cSld name="{name}">{bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld></p:sldLayout>'
    )


def pres_xml(cx, cy, slide_count, title_pt=1800):
    ids = ''.join(f'<p:sldId id="{256 + i}" r:id="rId{i + 3}"/>' for i in range(slide_count))
    return (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="6858000" cy="9144000"/>'
        f'<p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="{title_pt}"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>'
    )


def package(path, size, theme, master, layouts, slides, media=None, title=''):
    """slides: list of dicts {xml, layout (1-based), rels: [(id, type, target, external)], notes: [lines]}."""
    media = media or {}
    z = zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED)
    types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>'
    z.writestr('[Content_Types].xml', types)
    z.writestr('_rels/.rels', rels([('rId1', 'officeDocument', 'ppt/presentation.xml', False)]))
    z.writestr('ppt/presentation.xml', pres_xml(size[0], size[1], len(slides)))
    pres_rels = [('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml', False), ('rId2', 'theme', 'theme/theme1.xml', False)]
    for i in range(len(slides)):
        pres_rels.append((f'rId{i + 3}', 'slide', f'slides/slide{i + 1}.xml', False))
    z.writestr('ppt/_rels/presentation.xml.rels', rels(pres_rels))
    z.writestr('ppt/theme/theme1.xml', theme)
    z.writestr('ppt/slideMasters/slideMaster1.xml', master)
    z.writestr(
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        rels([(f'rId{i + 1}', 'slideLayout', f'../slideLayouts/slideLayout{i + 1}.xml', False) for i in range(len(layouts))] + [(f'rId{len(layouts) + 1}', 'theme', '../theme/theme1.xml', False)]),
    )
    for i, lx in enumerate(layouts):
        z.writestr(f'ppt/slideLayouts/slideLayout{i + 1}.xml', lx)
        z.writestr(f'ppt/slideLayouts/_rels/slideLayout{i + 1}.xml.rels', rels([('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml', False)]))
    for i, s in enumerate(slides):
        n = i + 1
        z.writestr(f'ppt/slides/slide{n}.xml', s['xml'])
        items = [('rId1', 'slideLayout', f'../slideLayouts/slideLayout{s["layout"]}.xml', False)] + list(s.get('rels', []))
        if s.get('notes'):
            items.append(('rIdNotes', 'notesSlide', f'../notesSlides/notesSlide{n}.xml', False))
            z.writestr(f'ppt/notesSlides/notesSlide{n}.xml', notes_xml(s['notes']))
            z.writestr(f'ppt/notesSlides/_rels/notesSlide{n}.xml.rels', rels([('rId1', 'slide', f'../slides/slide{n}.xml', False)]))
        z.writestr(f'ppt/slides/_rels/slide{n}.xml.rels', rels(items))
    for name, data in media.items():
        z.writestr(f'ppt/media/{name}', data)
    z.writestr('docProps/core.xml', f'<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title></cp:coreProperties>')
    z.close()


EMU_IN = 914400


# ---------------------------------------------------------------------------
# Google Slides export
# ---------------------------------------------------------------------------
def google():
    cx, cy = 9144000, 5143500
    arial = '<a:latin typeface="Arial"/><a:ea typeface="Arial"/>'
    title_style = f'<a:lvl1pPr algn="l"><a:defRPr sz="3600" b="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>{arial}</a:defRPr></a:lvl1pPr>'
    body_style = f'<a:lvl1pPr marL="457200" indent="-342900"><a:buClr><a:srgbClr val="000000"/></a:buClr><a:buSzPts val="1800"/><a:buChar char="&#9679;"/><a:defRPr sz="1800"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>{arial}</a:defRPr></a:lvl1pPr>'
    mshapes = (
        ph_sp(2, 'Title', 'title', None, xfrm(311700, 445025, 8520600, 572700))
        + ph_sp(3, 'Body', 'body', 1, xfrm(311700, 1152475, 8520600, 3416400))
    )
    master = master_xml(mshapes, f'<p:bg><p:bgPr>{solid("FFFFFF")}<a:effectLst/></p:bgPr></p:bg>', title_style, body_style, 3)
    layouts = [
        layout_xml('TITLE', 'title', ph_sp(2, 'Title', 'ctrTitle', None, xfrm(311700, 744575, 8520600, 2052600), lst=f'<a:lvl1pPr algn="ctr"><a:defRPr sz="5200"/></a:lvl1pPr>')
                   + ph_sp(3, 'Subtitle', 'subTitle', 1, xfrm(311700, 2834125, 8520600, 792600), lst='<a:lvl1pPr algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr>')),
        layout_xml('TITLE_AND_BODY', 'obj', ph_sp(2, 'Title', 'title', None) + ph_sp(3, 'Body', 'body', 1)),
        layout_xml('BLANK', 'blank', ''),
    ]
    s1 = slide_xml(
        ph_sp(2, 'Google Shape;55;p13', 'ctrTitle', None, xfrm(311700, 744575, 8520600, 2052600), body=para('Team offsite', '<a:pPr algn="ctr"/>', '<a:rPr lang="en"/>'))
        + ph_sp(3, 'Google Shape;56;p13', 'subTitle', 1, xfrm(311700, 2834125, 8520600, 792600), body=para('Planning for next year', '<a:pPr algn="ctr"/>', '<a:rPr lang="en"/>'))
    )
    bullets = ''.join(
        f'<a:p><a:pPr marL="457200" lvl="{lvl}" indent="-342900"><a:buSzPts val="1800"/><a:buChar char="&#9679;"/></a:pPr><a:r><a:rPr lang="en"/><a:t>{t}</a:t></a:r></a:p>'
        for lvl, t in [(0, 'Agenda'), (1, 'Welcome'), (1, 'Goals'), (0, 'Budget')]
    )
    s2 = slide_xml(
        ph_sp(2, 'Google Shape;61;p14', 'title', None, xfrm(311700, 445025, 8520600, 572700), body=para('Agenda', '', '<a:rPr lang="en"/>'))
        + ph_sp(3, 'Google Shape;62;p14', 'body', 1, xfrm(311700, 1152475, 4000000, 3416400), body=bullets)
        + pic(4, 'Google Shape;63;p14', 'rId2', 4600000, 1152475, 4000000, 2250000, 'Team photo')
        + sp(5, 'Google Shape;64;p14', xfrm(4600000, 3600000, 4000000, 700000), prst='roundRect', fill=solid('1155CC'), ln='<a:ln w="9525"><a:solidFill><a:srgbClr val="0B5394"/></a:solidFill></a:ln>',
             body=para('Book the venue', '<a:pPr algn="ctr"/>', '<a:rPr lang="en" sz="2000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Roboto"/></a:rPr>'))
    )
    s3 = slide_xml(
        ph_sp(2, 'Google Shape;70;p15', 'title', None, xfrm(311700, 445025, 8520600, 572700), body=para('Budget', '', '<a:rPr lang="en"/>'))
        + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Google Shape;71;p15"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        + f'<p:xfrm><a:off x="311700" y="1152475"/><a:ext cx="6000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/>'
        + '<a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/></a:tblGrid>'
        + ''.join(
            '<a:tr h="500000">' + ''.join(f'<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en" sz="1400"' + (' b="1"' if r == 0 else '') + f'/><a:t>{c}</a:t></a:r></a:p></a:txBody><a:tcPr' + (' ><a:solidFill><a:srgbClr val="D9EAD3"/></a:solidFill></a:tcPr>' if r == 0 else '/>') + '</a:tc>' for c in row) + '</a:tr>'
            for r, row in enumerate([('Item', 'Cost'), ('Venue', '$4,000'), ('Food', '$2,500')])
        )
        + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>',
        extra='<p:transition spd="med"><p:push dir="u"/></p:transition>',
    )
    package(
        'google-slides-export.pptx', (cx, cy), theme_xml('Simple Light', 'Arial', 'Arial', ['000000', 'FFFFFF', '595959', 'EEEEEE', '3D85C6', '6AA84F', 'F1C232', 'E06666', '8E7CC3', '76A5AF', '1155CC', '7F6000']),
        master, layouts,
        [
            {'xml': s1, 'layout': 1, 'notes': ['Open with the offsite photo.']},
            {'xml': s2, 'layout': 2, 'rels': [('rId2', 'image', '../media/image1.png', False)], 'notes': ['Walk through each agenda item.', 'Leave time for questions.']},
            {'xml': s3, 'layout': 2},
        ],
        {'image1.png': png(48, 27, (200, 120, 40))}, title='Team offsite',
    )


# ---------------------------------------------------------------------------
# Keynote export
# ---------------------------------------------------------------------------
def keynote():
    cx, cy = 12192000, 6858000
    title_style = '<a:lvl1pPr algn="l"><a:defRPr sz="4400"><a:solidFill><a:srgbClr val="1D1D1F"/></a:solidFill><a:latin typeface="Helvetica Neue"/></a:defRPr></a:lvl1pPr>'
    body_style = '<a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:srgbClr val="1D1D1F"/></a:solidFill><a:latin typeface="Helvetica Neue"/></a:defRPr></a:lvl1pPr>'
    mshapes = ph_sp(2, 'Title', 'title', None, xfrm(1016000, 508000, 10160000, 1270000)) + ph_sp(3, 'Body', 'body', 1, xfrm(1016000, 1905000, 10160000, 4318000))
    master = master_xml(mshapes, f'<p:bg><p:bgPr>{solid("FFFFFF")}<a:effectLst/></p:bgPr></p:bg>', title_style, body_style, 2)
    layouts = [
        layout_xml('Title & Bullets', 'obj', ph_sp(2, 'Title', 'title', None) + ph_sp(3, 'Body', 'body', 1)),
        layout_xml('Blank', 'blank', ''),
    ]
    triangle = (
        '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="50" y="0"/></a:moveTo>'
        '<a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>'
    )
    s1 = slide_xml(
        ph_sp(2, 'Title 1', 'title', None, body=para('Launch plan', '', '<a:rPr lang="en-US"/>'))
        + ph_sp(3, 'Content 2', 'body', 1, body=''.join(para(t, '', '<a:rPr lang="en-US"/>') for t in ['Soft launch in March', 'Press in April', 'General availability in June']),
                bodypr='<a:bodyPr><a:normAutofit fontScale="92500"/></a:bodyPr>'),
        extra='',
    )
    s1 = s1.replace('<a:p><a:r><a:rPr lang="en-US"/><a:t>Press in April</a:t></a:r></a:p>', f'<a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rIdLink" action="ppaction://hlinksldjump"/></a:rPr><a:t>Press in April</a:t></a:r></a:p>')
    group = (
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group 3"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1016000" y="2032000"/><a:ext cx="4064000" cy="2032000"/><a:chOff x="0" y="0"/><a:chExt cx="2032000" cy="1016000"/></a:xfrm></p:grpSpPr>'
        + sp(5, 'Rectangle 4', xfrm(0, 0, 1016000, 1016000), fill=solid('FF9500'))
        + sp(6, 'Rectangle 5', xfrm(1016000, 0, 1016000, 1016000), fill=solid('34C759'))
        + '</p:grpSp>'
    )
    s2 = slide_xml(
        sp(2, 'Text 1', xfrm(7000000, 1500000, 3500000, 600000, ' rot="-1200000"'), prst='rect', txbox=True, body=para('Rotated note', '', '<a:rPr lang="en-US" sz="2400" i="1"/>'))
        + group
        + f'<p:sp><p:nvSpPr><p:cNvPr id="7" name="Freeform 6"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>{xfrm(6000000, 3000000, 2000000, 1800000)}{triangle}{solid("5856D6")}</p:spPr></p:sp>'
        + pic(8, 'Picture 7', 'rId2', 1016000, 4500000, 2000000, 1500000, 'Diagram')
        + pic(9, 'Picture 8', 'rId3', 3500000, 4500000, 2000000, 1500000, 'Logo')
        + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Chart 9"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        + '<p:xfrm><a:off x="6000000" y="5000000"/><a:ext cx="4000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId4"/></a:graphicData></a:graphic></p:graphicFrame>'
    )
    package(
        'keynote-export.pptx', (cx, cy), theme_xml('Keynote', 'Helvetica Neue', 'Helvetica Neue', ['000000', 'FFFFFF', '1D1D1F', 'F2F2F7', '007AFF', '34C759', 'FF9500', 'FF3B30', '5856D6', '5AC8FA', '0563C1', '954F72']),
        master, layouts,
        [
            {'xml': s1, 'layout': 1, 'rels': [('rIdLink', 'slide', 'slide2.xml', False)], 'notes': ['Keynote presenter notes.']},
            {'xml': s2, 'layout': 2, 'rels': [('rId2', 'image', '../media/image1.emf', False), ('rId3', 'image', '../media/image2.png', False), ('rId4', 'chart', '../charts/chart1.xml', False)]},
        ],
        {'image1.emf': b'\x01\x00\x00\x00 EMF', 'image2.png': png(20, 20, (90, 90, 200))}, title='Launch plan',
    )


# ---------------------------------------------------------------------------
# LibreOffice Impress, as .pptx
# ---------------------------------------------------------------------------
def libreoffice_pptx():
    cx, cy = 9144000, 6858000
    title_style = '<a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Liberation Sans"/></a:defRPr></a:lvl1pPr>'
    body_style = '<a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Liberation Sans"/></a:defRPr></a:lvl1pPr>'
    mshapes = ph_sp(2, 'Title', 'title', None, xfrm(457200, 274638, 8229600, 1143000)) + ph_sp(3, 'Outline', 'body', 1, xfrm(457200, 1600200, 8229600, 4525963))
    master = master_xml(mshapes, '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>', title_style, body_style, 2)
    layouts = [
        layout_xml('Title, Content', 'obj', ph_sp(2, 'Title', 'title', None) + ph_sp(3, 'Content', 'body', 1)),
        layout_xml('Blank Slide', 'blank', '', attrs=' showMasterSp="0"'),
    ]
    gradient_bg = '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="1F3864"/></a:gs><a:gs pos="100000"><a:srgbClr val="2E75B6"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>'
    s1 = slide_xml(
        ph_sp(2, 'PlaceHolder 1', 'title', None, body=para('Annual report', '', '<a:rPr lang="en-US" sz="4400"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'))
        + ph_sp(3, 'PlaceHolder 2', 'body', 1, body=''.join(para(t, '', '<a:rPr lang="en-US"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>') for t in ['Results', 'Outlook'])),
        bg=gradient_bg,
        extra=f'<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="slow" p14:dur="1200"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>',
    )
    video = (
        '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Video 3"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rIdVid"/></p:nvPr></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>{xfrm(1000000, 1800000, 4000000, 2250000)}</p:spPr></p:pic>'
    )
    s2 = slide_xml(ph_sp(2, 'PlaceHolder 1', 'title', None, body=para('Demo video', '', '<a:rPr lang="en-US"/>')) + video)
    s3 = slide_xml(sp(2, 'CustomShape 1', xfrm(1000000, 2000000, 4000000, 1000000), prst='ellipse', fill=solid('FFCC00'), body=para('Thanks', '<a:pPr algn="ctr"/>', '<a:rPr lang="en-US" sz="3200"/>')), show='0')
    package(
        'libreoffice-impress.pptx', (cx, cy), theme_xml('LibreOffice', 'Liberation Sans', 'Liberation Sans', ['000000', 'FFFFFF', '1F3864', 'EEECE1', '729FCF', 'E96B1D', '3B9B3B', 'FFCC00', '9A3FC8', '00A6B2', '0000FF', '800080']),
        master, layouts,
        [
            {'xml': s1, 'layout': 1, 'notes': ['Notes from Impress.']},
            {'xml': s2, 'layout': 1, 'rels': [('rId2', 'image', '../media/poster.png', False), ('rIdVid', 'video', '../media/clip.mp4', False)]},
            {'xml': s3, 'layout': 2},
        ],
        {'poster.png': png(16, 9, (10, 10, 10)), 'clip.mp4': b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 64}, title='Annual report',
    )


# ---------------------------------------------------------------------------
# LibreOffice Impress, as .odp
# ---------------------------------------------------------------------------
def libreoffice_odp():
    ns = (
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
        'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
        'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
        'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:smil="urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0" '
        'xmlns:anim="urn:oasis:names:tc:opendocument:xmlns:animation:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xml="http://www.w3.org/XML/1998/namespace"'
    )
    styles = f'''<?xml version="1.0" encoding="UTF-8"?><office:document-styles {ns}>
<office:styles>
<style:style style:name="Title" style:family="paragraph"><style:text-properties fo:font-size="32pt" fo:font-weight="bold" style:font-name="Liberation Sans"/></style:style>
<draw:gradient draw:name="Grad1" draw:style="linear" draw:start-color="#ffffff" draw:end-color="#cfe2f3" draw:angle="0"/>
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout>
<style:style style:name="Mdp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#f2f2f2"/></style:style>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="Mdp1"/></office:master-styles>
</office:document-styles>'''
    content = f'''<?xml version="1.0" encoding="UTF-8"?><office:document-content {ns}>
<office:automatic-styles>
<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:transition-type="automatic" presentation:transition-speed="slow" smil:type="fade"/></style:style>
<style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>
<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff9900" draw:stroke="solid" svg:stroke-color="#663300" svg:stroke-width="0.05cm"/></style:style>
<style:style style:name="gr2" style:family="graphic"><style:graphic-properties draw:fill="none" draw:stroke="none"/><style:text-properties fo:font-size="24pt"/></style:style>
<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="40pt" fo:font-weight="bold"/></style:style>
<style:style style:name="P2" style:family="paragraph"><style:text-properties fo:font-size="24pt"/></style:style>
<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#cc0000"/></style:style>
<text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="&#8226;"/></text:list-style>
<text:list-style style:name="L2"><text:list-level-style-number text:level="1" style:num-suffix="."/></text:list-style>
<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="8cm"/></style:style>
<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="1.5cm"/></style:style>
<style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#d9ead3"/></style:style>
</office:automatic-styles>
<office:body><office:presentation>
<draw:page draw:name="page1" draw:style-name="dp1" draw:master-page-name="Default">
 <draw:frame draw:style-name="gr2" draw:id="id1" presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p text:style-name="P1">Site survey</text:p></draw:text-box></draw:frame>
 <draw:frame draw:style-name="gr2" draw:id="id2" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="8cm"><draw:text-box>
  <text:list text:style-name="L1"><text:list-item><text:p text:style-name="P2">Findings <text:span text:style-name="T1">urgent</text:span></text:p></text:list-item>
  <text:list-item><text:list><text:list-item><text:p text:style-name="P2">Access road</text:p></text:list-item></text:list></text:list-item></text:list>
  <text:list text:style-name="L2"><text:list-item><text:p text:style-name="P2">Next steps <text:a xlink:href="https://example.com/plan">plan</text:a></text:p></text:list-item></text:list>
 </draw:text-box></draw:frame>
 <presentation:notes><draw:frame presentation:class="notes" svg:x="1cm" svg:y="1cm" svg:width="10cm" svg:height="5cm"><draw:text-box><text:p>Remember the access road photos.</text:p><text:p>Second note line.</text:p></draw:text-box></draw:frame></presentation:notes>
 <anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence"><anim:par smil:begin="next"><anim:par smil:begin="0s"><anim:par smil:begin="0s" presentation:node-type="on-click" presentation:preset-id="ooo-entrance-fade-in" presentation:preset-class="entrance"><anim:set smil:targetElement="id2" smil:attributeName="visibility" smil:to="visible"/></anim:par></anim:par></anim:par></anim:seq></anim:par>
</draw:page>
<draw:page draw:name="page2" draw:style-name="dp2" draw:master-page-name="Default">
 <draw:custom-shape draw:style-name="gr1" svg:x="3cm" svg:y="3cm" svg:width="8cm" svg:height="4cm"><text:p text:style-name="P2">Plain box</text:p><draw:enhanced-geometry draw:type="round-rectangle"/></draw:custom-shape>
 <draw:line draw:style-name="gr1" svg:x1="3cm" svg:y1="9cm" svg:x2="15cm" svg:y2="9cm"/>
 <draw:frame draw:style-name="gr2" svg:x="3cm" svg:y="10cm" svg:width="12cm" svg:height="4cm"><draw:image xlink:href="Pictures/chart.png" xlink:type="simple"/></draw:frame>
 <draw:frame draw:style-name="gr2" svg:x="16cm" svg:y="3cm" svg:width="16cm" svg:height="3cm"><table:table><table:table-column table:style-name="co1" table:number-columns-repeated="2"/>
  <table:table-row table:style-name="ro1"><table:table-cell table:style-name="ce1" table:number-columns-spanned="2"><text:p>Totals</text:p></table:table-cell><table:covered-table-cell/></table:table-row>
  <table:table-row table:style-name="ro1"><table:table-cell><text:p>North</text:p></table:table-cell><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row></table:table></draw:frame>
</draw:page>
</office:presentation></office:body></office:document-content>'''
    z = zipfile.ZipFile('libreoffice-impress.odp', 'w', zipfile.ZIP_DEFLATED)
    z.writestr('mimetype', 'application/vnd.oasis.opendocument.presentation', compress_type=zipfile.ZIP_STORED)
    z.writestr('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/></manifest:manifest>')
    z.writestr('meta.xml', f'<?xml version="1.0" encoding="UTF-8"?><office:document-meta {ns}><office:meta><dc:title>Site survey</dc:title></office:meta></office:document-meta>')
    z.writestr('styles.xml', styles)
    z.writestr('content.xml', content)
    z.writestr('Pictures/chart.png', png(40, 12, (60, 160, 90)))
    z.close()


if __name__ == '__main__':
    google()
    keynote()
    libreoffice_pptx()
    libreoffice_odp()
