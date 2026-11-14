import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { decode } from 'jpeg-js';
import { buildShareImage, SHARE_H, SHARE_W } from './share-image';

describe('image d\'aperçu des liens partagés', () => {
  const poster = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'poster.jpg'));

  it('produit un JPEG 1200×630 léger', async () => {
    const out = await buildShareImage(poster, 'image/jpeg');
    expect(out.length).toBeLessThanOrEqual(220 * 1024);
    expect(imageSize(out)).toMatchObject({ type: 'jpg', width: SHARE_W, height: SHARE_H });
    const px = decode(out, { useTArray: true });
    expect([px.width, px.height]).toEqual([SHARE_W, SHARE_H]);
  }, 20000);

  it('accepte un PNG minuscule', async () => {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    expect(imageSize(await buildShareImage(PNG, 'image/png'))).toMatchObject({ width: SHARE_W, height: SHARE_H });
  }, 20000);
});
