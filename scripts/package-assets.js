'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ICON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Validate the configured Marketplace icon before creating package outputs. */
function validatePackageIcon(root, icon) {
  if (typeof icon !== 'string' || icon.trim() === '') {
    throw new Error('package.json 必须配置 icon，指向仓库内的 PNG 或 JPEG 图标。');
  }
  const repository = path.resolve(root);
  const candidate = path.resolve(repository, icon);
  if (path.isAbsolute(icon) || !isInside(repository, candidate)) {
    throw new Error(`扩展图标路径必须是仓库内的相对路径：${icon}。`);
  }
  const extension = path.extname(candidate).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new Error(`扩展图标仅支持 PNG 或 JPEG（.png、.jpg、.jpeg）：${icon}。`);
  }
  let realRoot, realFile;
  try {
    realRoot = fs.realpathSync(repository);
    realFile = fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(`扩展图标不存在或无法访问：${icon}（${error.code || error.message}）。`);
  }
  if (!isInside(realRoot, realFile)) {
    throw new Error(`扩展图标链接指向仓库外，拒绝打包：${icon}。`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(realFile, 'r');
  } catch (error) {
    throw new Error(`扩展图标无法读取：${icon}（${error.code || error.message}）。`);
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`扩展图标必须是普通文件：${icon}。`);
    if (stat.size > MAX_ICON_BYTES) {
      throw new Error(`扩展图标超过 Marketplace 的 1024 KB（${MAX_ICON_BYTES} 字节）上限：${icon}，实际 ${stat.size} 字节。请压缩图标后重试。`);
    }
    const header = Buffer.alloc(8);
    const count = fs.readSync(descriptor, header, 0, header.length, 0);
    const isPng = count === 8 && header.equals(PNG_SIGNATURE);
    const isJpeg = count >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    if (!(extension === '.png' ? isPng : isJpeg)) {
      throw new Error(`扩展图标内容与 PNG/JPEG 文件扩展名不匹配：${icon}。`);
    }
    return {path: realFile, size: stat.size, format: isPng ? 'png' : 'jpeg'};
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = {validatePackageIcon, MAX_ICON_BYTES};
