'use strict';

/** Check packaging policy before creating output files or starting vsce. */
function validatePackageRequest(branch, options) {
  if (!Array.isArray(options) || options.some(option => option !== '--pre-release')) {
    throw new Error('打包仅支持 --pre-release 参数；不接受分支覆盖或绕过参数。');
  }
  if (options.length > 1) throw new Error('--pre-release 参数不能重复。');
  if (!branch || branch === 'HEAD') throw new Error('无法确认当前 Git 分支，拒绝打包；分离 HEAD 不允许打包。');
  if (branch === 'main') throw new Error('main 分支已冻结，禁止打包发布。');
  if (branch !== 'feature' && branch !== 'develop') {
    throw new Error(`仅允许 feature 或 develop 分支打包，当前分支：${branch}。`);
  }
  if (branch === 'feature' && !options.includes('--pre-release')) {
    throw new Error('feature 分支只能生成预发布包。请使用 npm run package -- --pre-release。');
  }
}

module.exports = { validatePackageRequest };
