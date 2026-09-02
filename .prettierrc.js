module.exports = {
  ...require('mwts/.prettierrc.json'),
  // 对齐 data-sync-service 的 prettier 策略:用 auto 而非 crlf/lf。
  // auto = 文件当前是 CRLF 就保持 CRLF、是 LF 就保持 LF,prettier 不强制改行尾,
  // 因此 Windows 工作区存 CRLF 也不会报 Delete ␍;仓库层的换行统一交由 .gitattributes
  // (* text=auto eol=lf) 在 commit 时归一为 LF 入库。这样格式化后不会反复报警。
  endOfLine: 'auto',
  printWidth: 120,
};
