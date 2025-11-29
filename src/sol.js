// benchmark.js

// 約10MB（1,000万文字）の巨大な文字列を作成
// ※ JavaScriptの文字列は内部的にUTF-16なので、
//    実メモリでは約20MB〜を消費します
const heavyString =
  "a".repeat(5 * 1024 * 1024) + "xyz123" + "b".repeat(5 * 1024 * 1024);

// ----------------------------------------------------
// 1. Stack版 (文字列コピーあり)
// ----------------------------------------------------
function isPalindromeStack(s) {
  // ここで巨大なコピーが発生！
  const cleanStr = s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const stack = [];
  const len = cleanStr.length;
  const mid = Math.floor(len / 2);

  // ここでさらに配列のメモリ確保！
  for (let i = 0; i < mid; i++) {
    stack.push(cleanStr[i]);
  }

  // 後半と照合
  const startIndex = len % 2 === 0 ? mid : mid + 1;
  for (let i = startIndex; i < len; i++) {
    if (stack.pop() !== cleanStr[i]) {
      return false;
    }
  }

  return true;
}

// ----------------------------------------------------
// 2. Two Pointers版 (コピーなし)
// ----------------------------------------------------
function isPalindromeOptimized(s) {
  let left = 0;
  let right = s.length - 1;

  while (left < right) {
    // 英数字以外をスキップ
    while (left < right && !/[a-z0-9]/i.test(s[left])) {
      left++;
    }
    while (left < right && !/[a-z0-9]/i.test(s[right])) {
      right--;
    }

    // 文字列生成も配列生成もしない
    if (s[left].toLowerCase() !== s[right].toLowerCase()) {
      return false;
    }

    left++;
    right--;
  }

  return true;
}

// ----------------------------------------------------
// 実行と結果表示
// ----------------------------------------------------
console.log("🔥 メモリ使用量ベンチマーク (Node.js)");
console.log(`📝 文字列サイズ: ${heavyString.length.toLocaleString()} 文字`);
console.log("--------------------------------------------------");

// GCをできるだけ発動させてからベースライン取得
if (global.gc) {
  global.gc();
}

// Stack版の計測
const startMemStack = process.memoryUsage().heapUsed;
const resultStack = isPalindromeStack(heavyString);
const endMemStack = process.memoryUsage().heapUsed;
const memoryDiffStack = endMemStack - startMemStack;

console.log("[Stack版]");
console.log(`結果: ${resultStack}`);
console.log(
  `増えたメモリ: 約 ${(memoryDiffStack / 1024 / 1024).toFixed(2)} MB`
);
console.log("(解説: 元の文字列のコピー + 配列生成でメモリを大量消費)");
console.log("--------------------------------------------------");

// GCを再度発動
if (global.gc) {
  global.gc();
}

// Two Pointers版の計測
const startMemOpt = process.memoryUsage().heapUsed;
const resultOpt = isPalindromeOptimized(heavyString);
const endMemOpt = process.memoryUsage().heapUsed;
const memoryDiffOpt = endMemOpt - startMemOpt;

console.log("[Two Pointers版]");
console.log(`結果: ${resultOpt}`);
console.log(`増えたメモリ: 約 ${(memoryDiffOpt / 1024 / 1024).toFixed(2)} MB`);
console.log("(解説: ポインタ変数のみでメモリ使用量はほぼゼロ)");
console.log("--------------------------------------------------");
