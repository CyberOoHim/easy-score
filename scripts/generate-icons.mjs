import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
const iconsDir = path.resolve('public/icons');

const iconSvgPath = path.join(iconsDir, 'icon.svg');
const maskableSvgPath = path.join(iconsDir, 'icon-maskable.svg');
const faviconSvgPath = path.join(publicDir, 'favicon.svg');

const iconSvg = fs.readFileSync(iconSvgPath);
const maskableSvg = fs.readFileSync(maskableSvgPath);
const faviconSvg = fs.readFileSync(faviconSvgPath);

async function generate() {
  console.log('Generating PNG and ICO icons with sharp...');

  // 1. Standard PWA icons (192x192 and 512x512)
  await sharp(iconSvg)
    .resize(192, 192)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'icon-192x192.png'));
  console.log('✓ Created public/icons/icon-192x192.png');

  await sharp(iconSvg)
    .resize(192, 192)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'pwa-192x192.png'));
  console.log('✓ Created public/pwa-192x192.png');

  await sharp(iconSvg)
    .resize(512, 512)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'icon-512x512.png'));
  console.log('✓ Created public/icons/icon-512x512.png');

  await sharp(iconSvg)
    .resize(512, 512)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'pwa-512x512.png'));
  console.log('✓ Created public/pwa-512x512.png');

  // 2. Maskable PWA icons (192x192 and 512x512)
  await sharp(maskableSvg)
    .resize(192, 192)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'icon-maskable-192x192.png'));
  console.log('✓ Created public/icons/icon-maskable-192x192.png');

  await sharp(maskableSvg)
    .resize(512, 512)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'icon-maskable-512x512.png'));
  console.log('✓ Created public/icons/icon-maskable-512x512.png');

  await sharp(maskableSvg)
    .resize(512, 512)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'pwa-maskable-512x512.png'));
  console.log('✓ Created public/pwa-maskable-512x512.png');

  // 3. Apple Touch Icon (180x180)
  // Apple Touch Icon standard is 180x180 with solid non-transparent or rich background
  await sharp(iconSvg)
    .resize(180, 180)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(iconsDir, 'apple-touch-icon.png'));
  console.log('✓ Created public/icons/apple-touch-icon.png');

  await sharp(iconSvg)
    .resize(180, 180)
    .png({ quality: 100, compressionLevel: 9 })
    .toFile(path.join(publicDir, 'apple-touch-icon.png'));
  console.log('✓ Created public/apple-touch-icon.png');

  // 4. Favicon (32x32 and 48x48 PNG/ICO)
  // Sharp can generate standard PNG for favicon.ico or 32x32/48x48 PNG
  const favicon32Buffer = await sharp(faviconSvg)
    .resize(32, 32)
    .png()
    .toBuffer();

  const favicon48Buffer = await sharp(faviconSvg)
    .resize(48, 48)
    .png()
    .toBuffer();

  // Write 32x32 as favicon.png & also create valid multi-frame or 32px ICO
  // Basic ICO header for PNG payload
  function createIcoFromPng(pngBuffer, width, height) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // image type (1 = icon)
    header.writeUInt16LE(1, 4); // count of images

    const entry = Buffer.alloc(16);
    entry.writeUInt8(width === 256 ? 0 : width, 0); // width
    entry.writeUInt8(height === 256 ? 0 : height, 1); // height
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngBuffer.length, 8); // image size in bytes
    entry.writeUInt32LE(6 + 16, 12); // image offset

    return Buffer.concat([header, entry, pngBuffer]);
  }

  const icoBuffer = createIcoFromPng(favicon48Buffer, 48, 48);
  fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuffer);
  console.log('✓ Created public/favicon.ico');

  console.log('All icons generated successfully!');
}

generate().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
