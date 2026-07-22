// ============================================================================
// ドメイン: OCR後処理 (リアーキ ステップ2 — ARCHITECTURE-AUDIT.md §4-2)
// ----------------------------------------------------------------------------
// 画像認識 (AI Vision) の結果をアプリのマスタに突き合わせる補正ロジック群。
// ここは実運用で踏んだ誤認識への対処が蓄積された「地雷処理の塊」— 挙動を
// 変えるときは必ず tests/run-tests.mjs に再現ケースを足してから。
//
// アプリ状態 (_nikkeCharsCache / currentData / BOSS_ATTRIBUTES 等) は一切読まず、
// 全て引数で受ける。index.html 側は同名の薄いアダプタがグローバルを集めて渡す。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    // 共通の名前正規化 (NFKC + 全角コロン→半角 + 空白除去 + 先頭バースト記号除去)。
    // 「MAXアニス」「Ⅲラピ」のような画面上のバーストレベル表記を剥がして照合する
    function normNameForMatch(s) {
        if (typeof s !== 'string') return '';
        let n = s.normalize('NFKC').replace(/[：]/g, ':').replace(/\s+/g, '');
        n = n.replace(/^(MAX|[IVXⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]{1,4})(?=[:぀-ヿ一-鿿])/, '');
        return n;
    }

    // 簡易類似度 (Levenshtein) + LCP/LCS/部分文字列ボーナス。0..1 (1=一致)。
    // 段階的な早期リターンは「OCRの読み間違いパターン別の救済」なので順序を変えないこと:
    //   接頭辞/部分文字列 (見切れ) → LCP (末尾崩れ) → LCS (先頭文字誤読) → Levenshtein (総合)
    function simBetween(a, b) {
        if (!a || !b) return 0;
        const A = normNameForMatch(a), B = normNameForMatch(b);
        if (A === B) return 1;
        // 接頭辞関係 → 高信頼度
        if (A.length >= 3 && B.length >= 3 && (B.startsWith(A) || A.startsWith(B))) return 0.92;
        // 部分文字列
        if (A.length >= 5 && B.includes(A)) return 0.92;
        if (B.length >= 5 && A.includes(B)) return 0.92;
        const shortLen = Math.min(A.length, B.length);
        // 共通接頭辞 LCP
        const lcpLen = (() => {
            for (let i = 0; i < shortLen; i++) if (A[i] !== B[i]) return i;
            return shortLen;
        })();
        if (lcpLen >= 5) {
            const ratio = lcpLen / shortLen;
            if (ratio >= 0.7) return 0.88;
            if (ratio >= 0.5) return 0.78;
        }
        // 最長共通部分列 LCS (先頭文字誤読を救済する重要ボーナス)
        const m = A.length, n = B.length;
        if (m === 0 || n === 0) return 0;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        // dp は Levenshtein 用も兼ね、LCS は別途
        let prev = new Array(n + 1).fill(0);
        let curr = new Array(n + 1).fill(0);
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                curr[j] = (A[i - 1] === B[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
            }
            const tmp = prev; prev = curr; curr = tmp;
            curr.fill(0);
        }
        const lcs = prev[n];
        if (lcs >= 5) {
            const ratio = lcs / shortLen;
            if (ratio >= 0.85) return 0.88;
            if (ratio >= 0.7) return 0.78;
        }
        // 通常 Levenshtein
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
            dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
        }
        return 1 - dp[m][n] / Math.max(m, n);
    }

    /**
     * OCRが返した名前をマスタの canonical_name に解決する。
     * @param {Object} args
     * @param {string} args.rawName
     * @param {{canonical_name:string}[]} args.master      キャラマスタ (空なら raw のまま返す)
     * @param {Map<string, {canonical_name:string}>=} args.exactByName  正式名+エイリアスの完全一致辞書
     * @param {number=} args.threshold                     類似度の下限 (既定0.50)
     * @returns {string|null} 解決名 / 解決できなければ raw / raw が不正なら null
     */
    function fuzzyResolveCharacter({ rawName, master, exactByName, threshold = 0.50 }) {
        if (!rawName || typeof rawName !== 'string') return null;
        const list = master || [];
        if (list.length === 0) return rawName;
        // exact (name or alias) 優先
        if (exactByName && exactByName.has(rawName)) return exactByName.get(rawName).canonical_name;
        const rNorm = normNameForMatch(rawName);
        if (rNorm.length < 3) return rawName;   // 短すぎは誤マッチ防止で raw のまま
        let best = null, bestScore = 0;
        for (const m of list) {
            const score = simBetween(rNorm, m.canonical_name);   // simBetween 内で正規化
            if (score > bestScore) { bestScore = score; best = m; }
        }
        return (best && bestScore >= threshold) ? best.canonical_name : rawName;
    }

    /**
     * 複数枚の OCR 結果を1件に統合する (旧 _ocrAttackMultiAndMerge の純粋部分)。
     * - スカラー項目は「最初に値が入っていた画像」を採用
     * - characters: 5枚揃いの画像があれば優先、無ければ全画像の和集合 (順序保持・重複除去)
     * @param {Array<Object|null>} results  各画像の解析結果 (r.characters / r.bossName / ...)
     */
    function mergeOcrAttackResults(results) {
        const rs = (results || []).filter(Boolean);
        const pickFirst = (key) => rs.map(r => r?.[key]).find(v => v != null && v !== '');
        const fiveSet = rs.find(r => Array.isArray(r?.characters) && r.characters.filter(c => typeof c === 'string' && c.trim()).length >= 5);
        let characters;
        if (fiveSet) {
            characters = fiveSet.characters.filter(c => typeof c === 'string' && c.trim()).slice(0, 5);
        } else {
            const all = [];
            rs.forEach(r => (r?.characters || []).forEach(c => { if (typeof c === 'string' && c.trim() && !all.includes(c)) all.push(c); }));
            characters = all.slice(0, 5);
        }
        return {
            bossName: pickFirst('bossName') ?? null,
            totalDamage: pickFirst('totalDamage') ?? null,
            bossMaxHp: pickFirst('bossMaxHp') ?? null,
            bossRemainingHp: pickFirst('bossRemainingHp') ?? null,
            characters: characters.length > 0 ? characters : null,
        };
    }

    // よく出るリビルド系・歴代ボス名のハードコード補強 (ゲーム知識の定数)
    const STATIC_BOSS_KEYWORDS = {
        'H.S.T.A.': ['ヘスティア', 'スプレッド', 'プレート', 'ブラックスミス', 'ヘビーメタル'],
        'P.S.I.D.': ['ポセイドン', 'クリスタルアーマー', 'ランドイーター', 'ドクター', 'ビッグトルソー'],
        'Z.E.U.S.': ['ゼウス', 'ストームブリンガー', 'オベリスク', 'グレイブディガー', 'ポーター'],
        'D.M.T.R.': ['デメテル', 'クラーケン', 'マテリアル'],
        'A.N.M.I.': ['アネモイ', 'キューカンバー', 'モダニア', 'レイタンス'],
    };

    /**
     * OCRテキストから bossCode を推定する (旧 detectBossCodeFromText の純粋部分)。
     * @param {string} text
     * @param {Object} sources
     * @param {{code:string, name:string}[]=} sources.dynamicBossNames  実データ由来の ボス名→code
     *        (bossType 生値。ローマ数字接頭辞/ASCII の除去はこの関数側でやる)
     * @param {Object<string,string>=} sources.nameJpByCode  代表ボス名 (BOSS_ATTRIBUTES[].nameJP)
     * @returns {string|null}
     */
    function detectBossCode(text, { dynamicBossNames, nameJpByCode } = {}) {
        if (!text) return null;
        const codeToKeywords = {};
        const addKw = (code, kw) => {
            if (!kw) return;
            if (!codeToKeywords[code]) codeToKeywords[code] = new Set();
            codeToKeywords[code].add(kw);
        };
        // 動的データ: ローマ数字接頭辞 + 任意ASCIIを除去し、カタカナ/漢字部分を取り出す
        (dynamicBossNames || []).forEach(({ code, name }) => {
            if (!code || !name) return;
            const clean = String(name).replace(/^[IVX]+/, '').replace(/[\u0000-\u007F]/g, '');
            if (clean.length >= 3) addKw(code, clean);
        });
        // 静的フォールバック: nameJP "灼熱ヘスティア" → カタカナ部分 "ヘスティア"
        Object.entries(nameJpByCode || {}).forEach(([code, nameJp]) => {
            const m = String(nameJp || '').match(/[ァ-ヴー]+/g);
            if (m) m.forEach(s => { if (s.length >= 3) addKw(code, s); });
        });
        Object.entries(STATIC_BOSS_KEYWORDS).forEach(([code, kws]) => kws.forEach(k => addKw(code, k)));

        // OCRが日本語を「ス ト ー ム」のように分割して返すケースに対応するため、
        // 全角・半角空白と改行をすべて除去した文字列でも照合する
        const normalize = (s) => (s || '').replace(/[\s　]/g, '');
        const normalizedText = normalize(text);

        // 長いキーワードから優先的にチェック (誤マッチ低減)
        const flat = [];
        Object.entries(codeToKeywords).forEach(([code, set]) => {
            set.forEach(kw => flat.push({ code, kw: normalize(kw) }));
        });
        flat.sort((a, b) => b.kw.length - a.kw.length);

        // Step1: 完全一致
        for (const { code, kw } of flat) {
            if (kw && normalizedText.includes(kw)) return code;
        }
        // Step2: ファジーマッチ (トライグラム重なりスコア)。
        // OCR誤認識で1〜数文字欠けたり別字に化けるケースに対応
        const triMatchRatio = (kw) => {
            if (!kw || kw.length < 3) return 0;
            let hit = 0;
            const total = kw.length - 2;
            for (let i = 0; i < total; i++) {
                if (normalizedText.includes(kw.substring(i, i + 3))) hit++;
            }
            return hit / total;
        };
        let bestCode = null, bestScore = 0, bestHits = 0;
        for (const { code, kw } of flat) {
            if (!kw || kw.length < 4) continue;
            const ratio = triMatchRatio(kw);
            const hits = Math.round(ratio * (kw.length - 2));
            // 2トライグラム以上一致かつ一致率30%以上を候補とし、最もスコアの高いものを選ぶ
            if (hits >= 2 && ratio >= 0.3 && (ratio > bestScore || (ratio === bestScore && hits > bestHits))) {
                bestScore = ratio;
                bestHits = hits;
                bestCode = code;
            }
        }
        return bestCode;
    }

    root.ocrDomain = {
        normNameForMatch,
        simBetween,
        fuzzyResolveCharacter,
        mergeOcrAttackResults,
        detectBossCode,
        STATIC_BOSS_KEYWORDS,
    };
})(typeof window !== 'undefined' ? window : globalThis);
