"""Regenerates the small valid TIFFs the strip-validation tests read (tests/tiffStrict.test.mjs).

Test-only: the fixtures are committed, so nothing needs Pillow to run the suite. Run this only to
change them: python3 make_fixtures.py (needs Pillow built with libtiff).
"""
from PIL import Image, ImageDraw
import random

random.seed(7)

def page(mode, w=300, h=180, seed=0):
    img = Image.new('L', (w, h), 255)
    d = ImageDraw.Draw(img)
    for y in range(12, h - 12, 22):
        d.text((10 + seed * 3, y), "Skeleton argument, paragraph %d of the hearing bundle" % (y + seed), fill=0)
    d.rectangle([w - 60, 8, w - 12, 40], outline=0)
    if mode == '1':
        return img.convert('1')
    if mode == 'P':
        return img.convert('P')
    if mode == 'RGB':
        rgb = Image.merge('RGB', [img, img.point(lambda v: 255 - v // 3), img])
        return rgb
    return img

def save(name, img, **kw):
    img.save(name, format='TIFF', **kw)

save('raw_grey.tif', page('L'), compression=None)
save('packbits_grey.tif', page('L'), compression='packbits')
save('packbits_bw.tif', page('1'), compression='packbits')
save('lzw_grey.tif', page('L'), compression='tiff_lzw')
save('lzw_rgb.tif', page('RGB'), compression='tiff_lzw')
save('lzw_palette.tif', page('P'), compression='tiff_lzw')
save('lzw_predictor_rgb.tif', page('RGB'), compression='tiff_lzw', tiffinfo={317: 2})
save('group4_bw.tif', page('1'), compression='group4')
save('group3_bw.tif', page('1'), compression='group3')
save('rle_bw.tif', page('1'), compression='tiff_ccitt')
save('deflate_grey.tif', page('L'), compression='tiff_adobe_deflate')
save('jpeg_rgb.tif', page('RGB'), compression='jpeg')
first = page('1', seed=0)
first.save('multipage_group4.tif', format='TIFF', compression='group4', save_all=True,
           append_images=[page('1', seed=1), page('1', seed=2)])
g = page('L', seed=0)
g.save('multipage_lzw.tif', format='TIFF', compression='tiff_lzw', save_all=True,
       append_images=[page('L', seed=1), page('L', seed=2)])
# a blank page is a valid scan
save('blank_group4.tif', Image.new('1', (300, 180), 1), compression='group4')
save('blank_lzw.tif', Image.new('L', (300, 180), 255), compression='tiff_lzw')
save('black_group4.tif', Image.new('1', (300, 180), 0), compression='group4')
# 16 bits per sample
import struct
im16 = Image.new('I;16', (120, 80))
im16.putdata([(x * 517 + y * 131) % 65536 for y in range(80) for x in range(120)])
save('lzw_16bit.tif', im16, compression='tiff_lzw')
# Deflate and JPEG in several strips (rows per strip 32), with and without a predictor, so a strip that is
# not the whole picture, and a short last strip, are both exercised.
save('deflate_rgb_strips.tif', page('RGB', h=200), compression='tiff_adobe_deflate', tiffinfo={278: 32})
save('deflate_predictor.tif', page('L', h=200), compression='tiff_adobe_deflate', tiffinfo={278: 32, 317: 2})
save('deflate_bw_strips.tif', page('1', h=200), compression='tiff_adobe_deflate', tiffinfo={278: 32})
save('jpeg_grey.tif', page('L', h=200), compression='jpeg')
save('jpeg_rgb_strips.tif', page('RGB', h=200), compression='jpeg', tiffinfo={278: 32})
# a CMYK scan (a print-shop or prepress file): valid, and the decoder must not call it damaged
save('cmyk_lzw.tif', page('RGB').convert('CMYK'), compression='tiff_lzw')
