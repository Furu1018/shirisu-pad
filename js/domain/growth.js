// ============================================================================
// ユニオンメンバーの育成データ (BlaBlaLINK 由来) — 純ロジック
// ----------------------------------------------------------------------------
// 2026-09-08 決定 A1/B3/C1/D1 の C1・D1 側の中身。
// BlaBlaLINK の応答を PAD の言葉に移し替え、自分と他人を並べて比べられる形にする。
//
// ★ ここには通信も DOM も置かない (テストで実際に回すため)。
//   取得はブックマークレット、保存は js/supabase-client.js の担当。
//
// 【BlaBlaLINK 側の癖】(2026-09-08 実機で確認)
//  - 突破は grade 0〜3。core は grade=3 のときだけ 1〜7。段階の通し番号は grade+core+1 (1〜11)
//  - オーバーロードは option_id (数値) でしか来ない。**意味は state_effects が無いと分からない**
//    ので、取り込みの時点で解決して保存する (あとから復元できない)
//  - チャージ時間の短縮だけ function_value が負で来る。表示は全部正のパーセントに揃える
//  - equip_tier 10 = 企業装備 (強化 0〜5 が equip_lv)。1〜9 は一般 T1〜T9 で強化は無い。0 は未装着
// ============================================================================
(function (root) {
    'use strict';

    /** ゲーム内部のオプション名 → 日本語。しりすこスクワッド blablalink.ts の表と同じ並び。 */
    const OVERLOAD_JP = {
        StatAtk: '攻撃力',
        IncElementDmg: '有利コード',
        StatAmmoLoad: '装弾数',
        StatCritical: 'クリティカル確率',
        StatCriticalDamage: 'クリティカルダメージ',
        StatChargeTime: 'チャージ速度',
        StatChargeDamage: 'チャージダメージ',
        StatAccuracyCircle: '命中率',
        IncHurtDef: '防御力',
        StatDef: '防御力',
    };

    // ★ 2026-09-09 に「属性ダメージ」→「有利コード」へ改名した (ゲーム内の呼び方に合わせる)。
    //   本番には旧キーで保存された行が残っているので、**読むときに寄せる**。
    //   寄せずに混在させると、順位も比較も同じ項目が2つに割れる
    const OVERLOAD_ALIAS = { '属性ダメージ': '有利コード' };

    /** 表示と並べ替えの順。見たい順 (有利コード → 攻撃 → クリ2種) を先頭に置く。 */
    const OVERLOAD_ORDER = [
        '有利コード', '攻撃力', 'クリティカル確率', 'クリティカルダメージ',
        '装弾数', 'チャージ速度', 'チャージダメージ', '命中率', '防御力',
    ];

    /** 保存済みの overload を現在のキーに寄せる。同じ項目に寄ったら足す。 */
    function normalizeOverload(o) {
        if (!o || typeof o !== 'object') return {};
        const out = {};
        for (const [k, v] of Object.entries(o)) {
            const key = OVERLOAD_ALIAS[k] || k;
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            out[key] = Number(((out[key] || 0) + n).toFixed(4));
        }
        return out;
    }

    /** 応答の接頭辞 → 部位名。胴が torso、手袋が arm。 */
    const PARTS = [['head', '頭'], ['torso', '胴'], ['arm', '腕'], ['leg', '脚']];
    const CORP_TIER = 10;    // これ以上が企業装備
    const MAX_CORE = 7;
    const MAX_GRADE = 3;

    // num は「無ければ 0」。装備の枠番号のように 0 が意味を持つ計算で使う。
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    // ★ val は「無ければ null」。保存する値はこちらを使う — `num(x) || null` と書くと
    //   **本当に 0 の値 (スキルLv0・戦闘力0・未突破) が「未取得」に化ける** (Codex指摘 2026-09-09)。
    //   化けると、画面は「—」なのに差分は 0 として計算される、という食い違いが出る
    const val = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const pick = (a, b) => (val(a) != null ? val(a) : val(b));
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    // ---- 突破とコア -------------------------------------------------------
    /** 段階の通し番号 1〜11。並べ替えと「どちらが上か」はこれで比べる。 */
    function growthRank(grade, core) {
        const g = clamp(num(grade), 0, MAX_GRADE);
        const c = g >= MAX_GRADE ? clamp(num(core), 0, MAX_CORE) : 0;
        return g + c + 1;
    }

    /** 人に見せる表記。「コア3」は 3凸済みを含意するので凸数を重ねて書かない。 */
    function gradeText(grade, core) {
        const g = clamp(num(grade), 0, MAX_GRADE);
        const c = clamp(num(core), 0, MAX_CORE);
        if (g < MAX_GRADE) return `${g}凸`;
        return c > 0 ? `コア${c}` : '3凸';
    }

    // ---- オーバーロード ---------------------------------------------------
    /**
     * state_effects → Map(option_id → { type, jp, value })。
     * 詳細を分割して受け取るので同じ id が何度も来る。先に来たものだけ使う。
     */
    function buildOptionMap(stateEffects) {
        const map = new Map();
        for (const effect of Array.isArray(stateEffects) ? stateEffects : []) {
            // ★ id は state_effects では文字列、装備スロットでは数値で来る (実測)。
            //   そのまま突き合わせると1つも一致せず、オーバーロードが丸ごと 0 になる
            const id = Number(effect && effect.id);
            if (!Number.isFinite(id) || map.has(id)) continue;
            const detail = (effect.function_details || [])[0] || {};
            const jp = OVERLOAD_JP[detail.function_type];
            if (!jp) continue;
            // チャージ時間だけ負で来る。表示は全部「増えるほど良い」正の値に揃える
            map.set(id, { type: detail.function_type, jp, value: Math.abs(num(detail.function_value)) / 100 });
        }
        return map;
    }

    /** 12スロット (4部位 × 3) を日本語キーで合算する。0 の項目は含めない。 */
    function overloadTotals(detail, optionMap) {
        const total = {};
        for (const [prefix] of PARTS) {
            for (const slot of [1, 2, 3]) {
                const id = num(detail && detail[`${prefix}_equip_option${slot}_id`]);
                const hit = id ? optionMap.get(id) : null;
                if (!hit) continue;
                total[hit.jp] = Number(((total[hit.jp] || 0) + hit.value).toFixed(4));
            }
        }
        return total;
    }

    /**
     * 埋まっているのに state_effects に無かった枠の数。
     * ★ これが 0 でないのに保存すると、オーバーロードが「無い」ことにされてしまう
     */
    function unresolvedOptions(detail, optionMap) {
        let bad = 0;
        for (const [prefix] of PARTS) {
            for (const slot of [1, 2, 3]) {
                const id = num(detail && detail[`${prefix}_equip_option${slot}_id`]);
                if (id && !optionMap.has(id)) bad += 1;
            }
        }
        return bad;
    }

    /** オーバーロードが何枠埋まっているか (12枠中)。育成の進み具合の目安になる。 */
    function overloadSlotCount(detail, optionMap) {
        let filled = 0;
        for (const [prefix] of PARTS) {
            for (const slot of [1, 2, 3]) {
                const id = num(detail && detail[`${prefix}_equip_option${slot}_id`]);
                if (id && optionMap.has(id)) filled += 1;
            }
        }
        return filled;
    }

    // ---- 装備 -------------------------------------------------------------
    /**
     * 4部位の装備。企業装備は強化レベルまで、一般は T番号、未装着は区別する。
     * ★ 「企業でなければ強化0」と畳むと、未装着と一般装備が同じに見えてしまう
     */
    function equipOf(detail) {
        return PARTS.map(([prefix, part]) => {
            const tier = num(detail && detail[`${prefix}_equip_tier`]);
            const lv = num(detail && detail[`${prefix}_equip_lv`]);
            const options = [1, 2, 3].map((s) => num(detail && detail[`${prefix}_equip_option${s}_id`]) || null);
            if (tier >= CORP_TIER) return { part, kind: '企業', tier, level: clamp(lv, 0, 5), options, text: `企業+${clamp(lv, 0, 5)}` };
            if (tier >= 1) return { part, kind: '一般', tier, level: 0, options, text: `T${tier}` };
            return { part, kind: '未装着', tier: 0, level: 0, options, text: '未装着' };
        });
    }

    // ---- 応答 → 保存する行 ------------------------------------------------
    /**
     * ブックマークレットが持ち帰った1人ぶんを、保存できる行の配列にする。
     *
     * @param {Object} a
     * @param {Object[]} a.characters   GetUserCharacters の characters (name_code / grade / core / lv)
     * @param {Object[]} a.details      GetUserCharacterDetails の character_details
     * @param {Object[]} a.stateEffects 同 state_effects (オーバーロードの意味)
     * @param {Object} a.nameCodeMap    data/blabla-name-codes.json の data
     * @param {string[]=} a.wanted      取り込みたい PAD のキャラ名 (省略なら全部)
     * @returns {{rows: Object[], unknown: Object[], skipped: string[]}}
     *   unknown = PAD に対応するキャラが無い name_code (新キャラ・コラボ)
     *   skipped = wanted に無いので落としたキャラ名
     */
    function toRows({ characters, details, stateEffects, nameCodeMap, wanted } = {}) {
        const optionMap = buildOptionMap(stateEffects);
        const want = Array.isArray(wanted) && wanted.length ? new Set(wanted) : null;
        // GetUserCharacters 側にしか grade/core が無い個体もあるので引けるようにしておく
        const baseByCode = new Map();
        for (const c of Array.isArray(characters) ? characters : []) {
            if (c && c.name_code != null) baseByCode.set(String(c.name_code), c);
        }

        const rows = [];
        const unknown = [];
        const skipped = [];
        const seen = new Set();
        let unresolved = 0;
        for (const detail of Array.isArray(details) ? details : []) {
            const code = detail && detail.name_code != null ? String(detail.name_code) : null;
            if (!code) continue;
            const known = nameCodeMap && nameCodeMap[code];
            const name = known && known.pad;
            if (!name) { unknown.push({ name_code: code, jp: (known && known.jp) || null }); continue; }
            if (want && !want.has(name)) { skipped.push(name); continue; }
            // 同じキャラが2度来たら先勝ち (保存先の主キーは季節×人×キャラ)
            if (seen.has(name)) continue;
            seen.add(name);

            const base = baseByCode.get(code) || {};
            // 詳細側を優先し、無ければ一覧側。どちらにも無ければ null (0 とは区別する)
            rows.push({
                character_name: name,
                name_code: Number(code),
                grade: pick(detail.grade, base.grade),
                core: pick(detail.core, base.core),
                // ★ レベルは**一覧側 (GetUserCharacters) を優先する** (2026-09-09 実機で発覚)。
                //   一覧の lv は「効いているレベル」= シンクロレベル (実機で 781)。
                //   詳細の lv は**個体レベル**で、シンクロ装置に預けたキャラは 1 のまま (上限 200)。
                //   詳細を優先すると、フル育成のキャラが「Lv1」として保存され、比較が嘘になる
                lv: pick(base.lv, detail.lv),
                skill1_lv: val(detail.skill1_lv),
                skill2_lv: val(detail.skill2_lv),
                ulti_skill_lv: val(detail.ulti_skill_lv),
                combat: val(detail.combat),
                attractive_lv: val(detail.attractive_lv),
                harmony_cube_tid: val(detail.harmony_cube_tid),
                harmony_cube_lv: val(detail.harmony_cube_lv),
                favorite_item_tid: val(detail.favorite_item_tid),
                favorite_item_lv: val(detail.favorite_item_lv),
                equip: equipOf(detail),
                overload: overloadTotals(detail, optionMap),
            });
            unresolved += unresolvedOptions(detail, optionMap);
        }
        // ★ 埋まっているのに意味が分からなかった枠の数。0 でなければ state_effects が
        //   足りていない = オーバーロードを「無い」として保存してはいけない (Codex指摘 2026-09-09)
        return { rows, unknown, skipped, optionsUnresolved: unresolved };
    }

    // ---- 取り込みの状態 ---------------------------------------------------
    /** BlaBlaLINK の応答コード → 保存する状態。非公開と一時的な失敗を混ぜない。 */
    const PRIVACY_CODES = new Set([1301002, 1303002]);
    function statusOfCode(code) {
        // ★ Number() に通さない。Number([]) も Number('') も 0 なので、
        //   壊れた応答が「成功」に化ける (Codex指摘 2026-09-09)
        if (!Number.isFinite(code)) return 'error';
        if (code === 0) return 'ok';
        if (PRIVACY_CODES.has(code)) return 'private';
        return 'error';
    }

    const STATUS_JP = {
        ok: '取り込み済み',
        private: '本人が非公開にしています',
        no_openid: '識別子が未設定です (運営の作業待ち)',
        error: '取得に失敗しました',
    };
    // 一覧のピル用の短い言い方。長いほうは title に出す。
    // ★ 綴りも言い回しもここが唯一 — 画面側で書き分けない
    const STATUS_SHORT = {
        ok: '取り込み済み',
        private: '非公開',
        no_openid: '未ひも付け',
        error: '失敗',
    };

    // ---- 取り込み ---------------------------------------------------------
    /** 取り込んだデータの目印。しりすこスクワッドの NKP1-/NKU1- と混ざらないよう別にする。 */
    const IMPORT_PREFIX = 'SPG1-';
    /** 公式サーバー。日本を先に見る (ほとんどが日本サーバー)。 */
    const AREAS = [81, 83, 84, 82, 85];

    /**
     * ブックマークレットが結果を出す箱。**閉じられるようにする** (実機FB 2026-09-09)。
     * ★ 色に # を使わない・大きさに % を使わない — javascript: の URL では
     *   「#」以降が断片として切り捨てられ、「%」は復号で壊れる。rgb() と vw/vh にする。
     */
    const SNIPPET_BOX = [
        'var old=document.getElementById("spgBox");if(old)old.remove();',
        'var wrap=document.createElement("div");wrap.id="spgBox";',
        'wrap.setAttribute("style","position:fixed;right:2vw;bottom:2vh;width:min(520px,92vw);max-height:56vh;'
            + 'z-index:2147483647;display:flex;flex-direction:column;gap:6px");',
        'var bar=document.createElement("div");bar.setAttribute("style","display:flex;justify-content:flex-end");',
        'var xb=document.createElement("button");xb.textContent="\u2715 \u9589\u3058\u308b";',
        'xb.setAttribute("style","font:12px sans-serif;font-weight:700;padding:7px 14px;border:0;border-radius:9px;'
            + 'background:rgb(69,214,208);color:rgb(3,9,15);cursor:pointer");',
        'xb.onclick=function(){wrap.remove();};bar.appendChild(xb);',
        'var box=document.createElement("textarea");',
        'box.setAttribute("style","flex:1;min-height:30vh;background:rgb(3,9,15);color:rgb(232,246,245);'
            + 'font:12px monospace;padding:10px;border:2px solid rgb(69,214,208);border-radius:9px");',
        'wrap.appendChild(bar);wrap.appendChild(box);document.body.appendChild(wrap);',
        'document.addEventListener("keydown",function(k){if(k.key==="Escape"&&document.getElementById("spgBox"))wrap.remove();});',
    ].join('');

    /**
     * ブックマークレットとして安全な URL にする。
     * ★ **必ず encodeURIComponent を通す** (実機FB 2026-09-09: 生のまま貼ると動かなくなった)。
     *   日本語をそのまま URL に置くとブラウザ・OS の組み合わせで壊れ、
     *   「#」があればそれ以降が消える。エスケープしておけば実行前に復号されるので中身は変わらない。
     */
    const asBookmarklet = (body) => 'javascript:' + encodeURIComponent('(function(){' + body + '})()');

    /**
     * BlaBlaLINK で実行してもらうブックマークレットを組み立てる。
     *
     * ★ **コンソールではなくブックマークレット**にする。blablalink.com は `debugger` を
     *   作り続ける anti-debug を入れており、DevTools を開いたままだと setTimeout も fetch も
     *   返らない (2026-09-08 実機確認)。DevTools を閉じていれば `debugger` は何もしない。
     * ★ 埋め込む値は JSON.stringify で入れる。名前に ' や \ が入っても壊れない。
     * ★ 出力はページ上のボックスに出す。DevTools を閉じているのでコンソールは使えない。
     *
     * @param {Object} a
     * @param {Array<{openid:string, label?:string}>} a.targets 取りに行く相手
     * @param {number[]=} a.wantedCodes 取りたい name_code (省略なら全部)。
     *   ★ 今回のレイドで使われたキャラだけに絞るためのもの。60件ずつに割って投げる
     * @param {number=} a.gapMs 1リクエストごとの間隔
     * @returns {string} `javascript:` から始まる1行
     */
    function buildImportSnippet({ targets, wantedCodes, gapMs = 350 } = {}) {
        const list = (Array.isArray(targets) ? targets : [])
            .map((t) => ({ openid: String(t && t.openid || '').trim(), label: String(t && t.label || '') }))
            .filter((t) => /^\d{6,}$/.test(t.openid));
        if (!list.length) throw new Error('取りに行く相手がいません (識別子が未設定です)');
        const codes = (Array.isArray(wantedCodes) ? wantedCodes : [])
            .map((c) => Number(c)).filter((c) => Number.isFinite(c) && c > 0);

        const D = {
            targets: list, codes, areas: AREAS, gap: Math.max(0, Number(gapMs) || 0),
            prefix: IMPORT_PREFIX, privacy: [...PRIVACY_CODES],
        };
        // 生成されるコードは1行。テンプレート内では // コメントを使わない (行末で全部消える)
        return asBookmarklet([
            'var D=' + JSON.stringify(D) + ';',
            SNIPPET_BOX,
            'var L=[];var say=function(s){L.push(s);box.value=L.join("\\n");};',
            'var gap=function(){return new Promise(function(r){setTimeout(r,D.gap);});};',
            'var call=function(route,body){return fetch("https://api.blablalink.com/api/game/proxy/"+route,{',
            'method:"POST",credentials:"include",headers:{"Content-Type":"application/json",'
                + '"X-Channel-Type":"2","X-Language":"ja","X-Common-Params":JSON.stringify({game_id:"29080",'
                + 'area_id:"global",source:"pc_web",intl_game_id:"29080",language:"ja",env:"prod"})},',
            'body:JSON.stringify(body)}).then(function(r){return r.json();});};',
            'var out={v:1,at:new Date().toISOString(),members:[]};',
            'var run=async function(){',
            'say("しりすこPAD 育成データの取り込み");',
            'say(D.targets.length+"人ぶんを取りに行きます。閉じずにお待ちください。");say("");',
            'for(var i=0;i<D.targets.length;i++){var t=D.targets[i];',
            'var rec={openid:t.openid,label:t.label,code:null,area:null,requested:0,'
                + 'characters:[],details:[],stateEffects:[]};',
            'try{',
            'var found=null;',
            'for(var a=0;a<D.areas.length;a++){await gap();',
            'var got=await call("Game/GetUserCharacters",{intl_open_id:t.openid,nikke_area_id:D.areas[a]});',
            'rec.code=got.code;',
            'if(D.privacy.indexOf(got.code)>=0){break;}',
            'var cs=(got.data||{}).characters||[];',
            'if(got.code===0&&cs.length){found={area:D.areas[a],characters:cs};break;}}',
            'if(found){rec.area=found.area;',
            'var want=D.codes.length?found.characters.filter(function(c){return D.codes.indexOf(c.name_code)>=0;})'
                + ':found.characters;',
            'rec.characters=want.map(function(c){return {name_code:c.name_code,grade:c.grade,core:c.core,lv:c.lv};});',
            'rec.requested=want.length;',
            'var ids=want.map(function(c){return c.name_code;});',
            'for(var at=0;at<ids.length;at+=60){await gap();',
            'var ch=await call("Game/GetUserCharacterDetails",{intl_open_id:t.openid,nikke_area_id:found.area,'
                + 'name_codes:ids.slice(at,at+60)});',
            'if(ch.code!==0){rec.code=ch.code;break;}',
            'var dd=ch.data||{};',
            '(dd.character_details||[]).forEach(function(d){rec.details.push(d);});',
            '(dd.state_effects||[]).forEach(function(e){var f=(e.function_details||[])[0]||{};',
            'rec.stateEffects.push({id:e.id,function_details:[{function_type:f.function_type,'
                + 'function_value:f.function_value}]});});}',
            'say((t.label||t.openid)+" → "+rec.details.length+"/"+rec.requested+"体");',
            '}else{say((t.label||t.openid)+" → 取得できず (code="+rec.code+")");}',
            // 1人が転んでも残りを続ける。ここで throw すると全員ぶんの結果が消える (Codex指摘)
            '}catch(e){if(rec.code===0||rec.code==null){rec.code=-1;}',
            'say((t.label||t.openid)+" → 通信に失敗 ("+(e&&e.message||e)+")");}',
            'out.members.push(rec);}',
            'say("");say("まとめています...");',
            'var packed=JSON.stringify(out);var text=packed;',
            'if(typeof CompressionStream==="function"){',
            'var gz=new Blob([packed]).stream().pipeThrough(new CompressionStream("gzip"));',
            'var bytes=new Uint8Array(await new Response(gz).arrayBuffer());var bin="";',
            'for(var b=0;b<bytes.length;b++){bin+=String.fromCharCode(bytes[b]);}',
            'text=D.prefix+btoa(bin);}',
            'L.length=0;box.value=text;box.focus();box.select();',
            'try{document.execCommand("copy");}catch(e){}',
            '};',
            'run().catch(function(e){say("");say("途中で止まりました: "+(e&&e.message||e));});',
        ].join(''));
    }

    /**
     * ブックマークレットの出力を読む。`SPG1-` は gzip+base64、それ以外は生の JSON。
     * 貼り付けは人が手でやるので、途中で切れた・別のものを貼った、が普通に起きる。
     */
    const MAX_PASTE = 8 * 1000 * 1000;      // 貼り付けの上限。30人ぶんでも数百KBなので十分すぎる
    const MAX_JSON = 32 * 1000 * 1000;     // 展開後の上限 (gzip 爆弾でブラウザを固めない)

    /** 展開しながら上限を超えたら**途中で**止める。全部展開してから測っても手遅れ (Codex指摘 2026-09-09)。 */
    async function _inflateCapped(bytes, maxBytes) {
        const body = new Response(bytes).body;
        if (!body) throw new Error('stream unavailable');
        const reader = body.pipeThrough(new DecompressionStream('gzip')).getReader();
        const decoder = new TextDecoder();
        let out = '';
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) {
                try { await reader.cancel(); } catch { /* 打ち切れなくても投げる */ }
                throw new Error('too large');
            }
            out += decoder.decode(value, { stream: true });
        }
        return out + decoder.decode();
    }

    async function parseImportPayload(text, { maxPaste = MAX_PASTE, maxJson = MAX_JSON } = {}) {
        const trimmed = String(text == null ? '' : text).trim();
        if (!trimmed) throw new Error('貼り付けた内容が空です。');
        // ★ 上限を置く。人が貼るものなので、これを超えるのは事故か別物 (Codex指摘 2026-09-09)
        if (trimmed.length > maxPaste) {
            throw new Error('貼り付けた内容が大きすぎます。取り込み用ブックマークレットの出力を貼ってください。');
        }

        let json = trimmed;
        if (trimmed.startsWith(IMPORT_PREFIX)) {
            try {
                const binary = atob(trimmed.slice(IMPORT_PREFIX.length));
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                json = await _inflateCapped(bytes, maxJson);
            } catch (e) {
                // 大きすぎと壊れているは別物 — 貼り直せば直るのかどうかが変わる
                if (e && e.message === 'too large') {
                    throw new Error('展開した内容が大きすぎます。取り込み用ブックマークレットの出力を貼ってください。');
                }
                throw new Error('データの展開に失敗しました。コピーが途中で切れていないか確認してください。');
            }
        }

        let box;
        try {
            box = JSON.parse(json);
        } catch {
            throw new Error('内容を認識できませんでした。ブックマークレットが出したものを丸ごと貼り付けてください。');
        }
        // 別のツールの出力を貼られたときは、何が違うのかを言う
        if (box && !Array.isArray(box.members) && (box.profile || box.areas)) {
            throw new Error('しりすこスクワッド用のデータのようです。PAD の取り込み用ブックマークレットで取り直してください。');
        }
        if (!box || !Array.isArray(box.members)) {
            throw new Error('内容を認識できませんでした。ブックマークレットが出したものを丸ごと貼り付けてください。');
        }
        return {
            at: typeof box.at === 'string' ? box.at : null,
            members: box.members.filter((m) => m && typeof m === 'object').map((m) => ({
                openid: String(m.openid || ''),
                label: String(m.label || ''),
                // ★ 数値でないものを Number() で 0 にしない (0 = 成功に化ける)
                code: Number.isFinite(m.code) ? m.code : null,
                area: Number.isFinite(m.area) ? m.area : null,
                requested: Number.isFinite(m.requested) ? m.requested : null,
                characters: Array.isArray(m.characters) ? m.characters : [],
                details: Array.isArray(m.details) ? m.details : [],
                stateEffects: Array.isArray(m.stateEffects) ? m.stateEffects : [],
            })),
        };
    }

    /**
     * 1人ぶんの取り込み結果を、保存できる形に整える。
     * ★ 保存してよいかの判断もここでする — 呼び出し側 (DOM) に散らさない。
     * @returns {{status:string, detail:string|null, rows:Object[], unknown:Object[], save:boolean}}
     */
    function prepareMember(member, { nameCodeMap, wanted } = {}) {
        const status = statusOfCode(member && member.code);
        if (status !== 'ok') {
            return { status, detail: STATUS_JP[status], rows: [], unknown: [], save: false };
        }
        const got = toRows({
            characters: member.characters, details: member.details, stateEffects: member.stateEffects,
            nameCodeMap, wanted,
        });
        // ★ 枠は埋まっているのに state_effects が足りない = オーバーロードが「無い」ことにされる。
        //   静かに嘘のデータを残すより、取り直してもらうほうがよい (2026-09-09 の決定)
        if (got.optionsUnresolved > 0) {
            return {
                status: 'error',
                detail: `オーバーロードを ${got.optionsUnresolved} 枠ぶん読み取れませんでした。取り直してください`,
                rows: [], unknown: got.unknown, save: false,
            };
        }
        if (!got.rows.length) {
            return { status: 'error', detail: '対象のキャラが1体も取れませんでした', rows: [], unknown: got.unknown, save: false };
        }
        // ★ 応答が code=0 でも、頼んだぶんの詳細が全部返るとは限らない。
        //   欠けたまま「そのシーズンのスナップショット」として残すと、静かに穴の空いた記録になる。
        //   ★ 件数の比較では騙される (重複・対応表に無いキャラ・wanted で外したぶんが数を埋める)。
        //   **頼んだ name_code が全部返っているか**を集合で見る (Codex指摘 2026-09-09)
        const codesOf = (list) => new Set((Array.isArray(list) ? list : [])
            .map((x) => (x && x.name_code != null ? String(x.name_code) : null)).filter(Boolean));
        const askedCodes = codesOf(member.characters);
        const gotCodes = codesOf(member.details);
        const missingCodes = [...askedCodes].filter((c) => !gotCodes.has(c));
        // requested は生成コードが記録した「頼んだ数」。characters 自体が途中で切れていたら気づける
        const requested = Number.isFinite(member.requested) ? member.requested : askedCodes.size;
        if (requested > 0 && (missingCodes.length > 0 || askedCodes.size < requested)) {
            const got_ = askedCodes.size - missingCodes.length;
            return {
                status: 'error',
                detail: `育成の詳細が ${got_}/${requested} 体しか返りませんでした。取り直してください`,
                rows: [], unknown: got.unknown, save: false,
            };
        }
        return { status: 'ok', detail: null, rows: got.rows, unknown: got.unknown, save: true };
    }

    // ---- 比べる -----------------------------------------------------------
    /** 比較する項目。上から順に並べて見せる。cmp は「大きいほうが育っている」。 */
    // ★ value は「無ければ null」を返す。0 に畳むと、画面が「—」なのに差分だけ
    //   計算される食い違いが出る (Codex指摘 2026-09-09)
    const lvText = (v) => (v == null ? '—' : `Lv${v}`);
    const FIELDS = [
        {
            key: 'growth', label: '突破',
            text: (r) => (r.grade == null && r.core == null ? '—' : gradeText(r.grade, r.core)),
            value: (r) => (r.grade == null && r.core == null ? null : growthRank(r.grade, r.core)),
        },
        { key: 'lv', label: 'レベル', text: (r) => lvText(r.lv), value: (r) => val(r.lv) },
        { key: 'skill1_lv', label: 'スキル1', text: (r) => lvText(r.skill1_lv), value: (r) => val(r.skill1_lv) },
        { key: 'skill2_lv', label: 'スキル2', text: (r) => lvText(r.skill2_lv), value: (r) => val(r.skill2_lv) },
        { key: 'ulti_skill_lv', label: 'バースト', text: (r) => lvText(r.ulti_skill_lv), value: (r) => val(r.ulti_skill_lv) },
        { key: 'combat', label: '戦闘力', text: (r) => (r.combat == null ? '—' : r.combat.toLocaleString('ja-JP')), value: (r) => val(r.combat) },
        { key: 'attractive_lv', label: '好感度', text: (r) => lvText(r.attractive_lv), value: (r) => val(r.attractive_lv) },
        // ★ キューブは 2026-09-09 に比較から外した (ユーザー要望)。データは取り込んだまま残している
        { key: 'favorite_item_lv', label: '指揮官ぬいぐるみ', text: (r) => lvText(r.favorite_item_lv), value: (r) => val(r.favorite_item_lv) },
    ];

    // ---- オーバーロードの項目 ------------------------------------------------
    //   ★ 戦闘力で順位を付けるとシンクロレベル順にしかならない (2026-09-09 ユーザー指摘)。
    //     オーバーロードは装備に乗る値なのでシンクロレベルの影響を受けず、育成の度合いがそのまま出る。
    const OL_PREFIX = 'ol:';
    const SUM_FIELD_KEY = 'ol+:有利コード+攻撃力';

    /**
     * その行のオーバーロード値。
     * ★ 「データが無い」(null) と「その項目が 0」を分ける — 0 にすると未取得の人が最下位に並ぶ
     */
    function overloadValue(row, key) {
        if (!row || !row.overload || typeof row.overload !== 'object') return null;
        const o = normalizeOverload(row.overload);
        const v = Number(o[key]);
        return Number.isFinite(v) ? v : 0;
    }
    const pctText = (v) => (v == null ? '—' : `${v.toFixed(2)}%`);

    const OVERLOAD_FIELDS = OVERLOAD_ORDER.map((k) => ({
        key: OL_PREFIX + k, label: k, overload: true,
        text: (r) => pctText(overloadValue(r, k)),
        value: (r) => overloadValue(r, k),
    }));

    /** 「有利コード＋攻撃」の合計 (2026-09-09 ユーザー要望)。 */
    const SUM_FIELD = {
        key: SUM_FIELD_KEY, label: '有利コード＋攻撃', overload: true,
        text: (r) => {
            const a = overloadValue(r, '有利コード');
            const b = overloadValue(r, '攻撃力');
            return (a == null || b == null) ? '—' : pctText(Number((a + b).toFixed(4)));
        },
        value: (r) => {
            const a = overloadValue(r, '有利コード');
            const b = overloadValue(r, '攻撃力');
            return (a == null || b == null) ? null : Number((a + b).toFixed(4));
        },
    };

    /** 比較・並べ替えで引ける全項目。 */
    const ALL_FIELDS = [...FIELDS, ...OVERLOAD_FIELDS, SUM_FIELD];

    /**
     * 自分と相手を項目ごとに並べる。
     * ★ 片方しか持っていない項目を「差 0」にしない — 「持っていない」と「同じ」は違う。
     * @returns {{rows: Object[], overload: Object[], missing: string|null}}
     */
    function compare(mine, theirs) {
        if (!mine && !theirs) return { rows: [], overload: [], missing: 'both' };
        const rows = FIELDS.map((f) => {
            const a = mine ? f.value(mine) : null;
            const b = theirs ? f.value(theirs) : null;
            let lead = 'same';
            if (a == null || b == null) lead = 'unknown';
            else if (a > b) lead = 'mine';
            else if (a < b) lead = 'theirs';
            return {
                key: f.key, label: f.label,
                mine: mine ? f.text(mine) : '—',
                theirs: theirs ? f.text(theirs) : '—',
                lead,
                diff: (a == null || b == null) ? null : Number((b - a).toFixed(4)),
            };
        });

        // オーバーロードは項目が可変なので、両方に出てくるキーを集めてから並べる
        const seen = new Set([
            ...Object.keys(normalizeOverload(mine && mine.overload)),
            ...Object.keys(normalizeOverload(theirs && theirs.overload)),
        ]);
        // ★ 五十音順ではなく**見たい順** (有利コード → 攻撃 → クリ2種 → …)。
        //   表に無いものは後ろに回す (ゲーム側に項目が増えても落とさない)
        const keys = [...OVERLOAD_ORDER.filter((k) => seen.has(k)),
            ...[...seen].filter((k) => !OVERLOAD_ORDER.includes(k)).sort()];
        const overload = keys.map((k) => {
            const a = overloadValue(mine, k);
            const b = overloadValue(theirs, k);
            let lead = 'same';
            if (a == null || b == null) lead = 'unknown';
            else if (a > b) lead = 'mine';
            else if (a < b) lead = 'theirs';
            return {
                key: k, label: k,
                mine: a == null ? '—' : `${a.toFixed(2)}%`,
                theirs: b == null ? '—' : `${b.toFixed(2)}%`,
                lead,
                diff: (a == null || b == null) ? null : Number((b - a).toFixed(4)),
            };
        });

        return {
            rows, overload,
            missing: !mine ? 'mine' : !theirs ? 'theirs' : null,
        };
    }

    /**
     * 編成 (キャラ名の配列) ぶんをまとめて比べる。D1 の「この編成の育成を見る」で使う。
     * @param {string[]} squad
     * @param {Object} mineByName   自分の育成 {キャラ名: row}
     * @param {Object} theirsByName 相手の育成
     */
    function compareSquad(squad, mineByName, theirsByName) {
        return (Array.isArray(squad) ? squad : []).filter(Boolean).map((name) => ({
            character: name,
            ...compare((mineByName || {})[name] || null, (theirsByName || {})[name] || null),
        }));
    }

    /** URL-safe base64 なら中身に開く。開けないときは null (「そのまま」と区別する) */
    function _unbase64(raw) {
        const t = String(raw == null ? '' : raw);
        if (!t || !/^[A-Za-z0-9_\-+/=]+$/.test(t)) return null;
        try {
            const guess = atob(t.replace(/-/g, '+').replace(/_/g, '/'));
            // 開けた結果が読める文字なら「包まれていた」とみなす
            return (guess && /^[\x20-\x7e]+$/.test(guess)) ? guess : null;
        } catch { return null; }
    }

    /**
     * 名寄せの入力を BlaBlaLINK の識別子 (intl_open_id) に読み替える。
     * プロフィールのアドレスをそのまま貼れるようにする — 運営に「URL から数字だけ抜いて」と言わせない。
     *
     * ★ **アドレスの openid は base64 で包まれている** (blablalink.com/user?openid=MTIzNDU2Nzg5)。
     *   しりすこスクワッドの personal-scan.ts が実機で確かめた事実で、生の数字を期待すると1件も読めない。
     *   包まれていない場合もあるので、開けたら開いた側・開けなければそのままを見る。
     * ★ 受けるのは「数字だけ」「?openid= 等を含むアドレス」「その値だけ (base64)」の3つ。
     *   それ以外の長い数字列 (アドレスの中の別のパラメータ) は拾わない —
     *   取り違えは他人の育成が別人に付く事故になる。
     * @returns {string|null}
     */
    function parseOpenid(text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return null;
        if (/^\d{6,}$/.test(s)) return s;                       // 数字だけ貼られた
        // アドレスの中の識別子パラメータ。値は base64 のことも生の数字のこともある
        const m = s.match(/[?&#](?:uid|openid|intl_open_id|open_id)=([^&#\s]+)/i);
        if (m) {
            let v = m[1];
            try { v = decodeURIComponent(v); } catch { /* %xx が壊れていればそのまま */ }
            const inner = _unbase64(v);
            const hit = String(inner == null ? v : inner).match(/(\d{6,})\s*$/);
            return hit ? hit[1] : null;
        }
        // アドレスではなく、パラメータの値だけを貼られたとき (包まれた識別子)
        const inner = _unbase64(s);
        if (inner) {
            const hit = inner.match(/(\d{6,})\s*$/);
            if (hit) return hit[1];
        }
        return null;
    }

    /** 識別子の署名。intl_open_id は "<ゲームID>-<数字>" を base64 で包んだもので、
     *  ゲームID 29080 (NIKKE) なら必ず "MjkwODAt" で始まる (2026-09-09 実機で確認)。
     *  この署名でページ全体を探せば、リンクの作りに依存せず拾える */
    const OPENID_B64_PREFIX = 'MjkwODAt';

    /**
     * ユニオンのメンバー一覧を読み取るブックマークレット。
     * 名前と識別子を一度に集める — 32人ぶんを1人ずつ貼るのは現実的でないため (ユーザー要望 2026-09-09)。
     *
     * ★ 探し方は4段構え。ページの作りに依存しないものから順に効く:
     *   ① ページ全体 (outerHTML) から "MjkwODAt…" を拾う — リンクでも属性でも埋め込みJSONでも当たる
     *   ② リンク (a[href]) の uid / openid。ここは**名前も**取れる
     *   ③ 画面の裏に埋まっている状態 (__NUXT__ / __NEXT_DATA__ / __INITIAL_STATE__)
     *   ④ 通信の記録 — 1回目の実行で fetch/XHR に耳を付け、ページを操作してから2回目で拾う
     *      (SPA は一覧を通信で取ってくるだけで、HTML には何も残らないことがある)
     * ★ **通信は経路で絞る** (2026-09-09 実機: 55人取れたが在籍は32人)。ユニオン募集のページでは
     *   他ユニオンのカード一覧 (QueryGuildCardList) や掲示板の投稿者 (Dynamics/…) まで混ざる。
     *   自分のユニオンの経路 (GetMyGuildInfo / GetGuildDetail / GetUnionRaidData / …Member…) を優先し、
     *   それが1件も無いときだけ全部を見る (絞りすぎて0件になるほうが困る)。
     * ★ 見つからないときは**何が見えたかを報告する** (2026-09-09 実機で空振り)。
     *   「見つかりません」だけだと、こちらで手の打ちようがない。
     * ★ 出力は「名前 <TAB> 識別子」の行。**人が読んで直せる形にする**。
     * ★ DevTools を閉じたまま使う (blablalink.com の anti-debug 対策) ので、結果はページ上の箱に出す。
     */
    function buildRosterSnippet() {
        return asBookmarklet([
            'var W=window;var S=W.__spgRoster||(W.__spgRoster={hooked:false,bodies:[],urls:[],routes:[]});',
            // 前の版が作った置き場には routes が無い (古い窓のまま押されることがある)
            'if(!S.routes)S.routes=[];if(!S.bodies)S.bodies=[];if(!S.urls)S.urls=[];',
            // ★ 耳は一番先に付ける — 後ろだと、押したあとに開くモーダルの通信しか拾えない (実機 2026-09-09)
            'if(!S.hooked){S.hooked=true;var PFX0="' + 'MjkwODAt' + '";',
            'var keep=function(u,t){try{if(!t)return;var nm=String(u||"").split("/").pop();',
            'if(nm&&S.routes.indexOf(nm)<0)S.routes.push(nm);',
            'if(S.bodies.length>40)return;',
            'if(t.indexOf("29080-")>=0||t.indexOf(PFX0)>=0||/open_?id/i.test(t)){S.bodies.push({u:String(u||""),t:t});S.urls.push(String(u).slice(0,120));}}catch(e){}};',
            'var of=W.fetch;if(of){W.fetch=function(){var u=arguments[0];var p=of.apply(this,arguments);',
            'try{p.then(function(r){try{r.clone().text().then(function(t){keep((u&&u.url)||u,t);});}catch(e){}});}catch(e){}return p;};}',
            'var os=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(){var x=this;',
            'try{x.addEventListener("load",function(){try{keep(x.responseURL,x.responseText);}catch(e){}});}catch(e){}',
            'return os.apply(this,arguments);};}',
            SNIPPET_BOX,
            'var L=[];var say=function(t){L.push(t);box.value=L.join("\\n");};',
            'say("しりすこPAD 名簿を読み取っています…");',
            'var digits=function(raw){if(!raw)return "";var t=String(raw);',
            'try{var g=atob(String(t).replace(/-/g,"+").replace(/_/g,"/"));if(g&&/^[\\x20-\\x7e]+$/.test(g)){t=g;}}catch(e){}',
            'var m=String(t).match(/(\\d{6,})\\s*$/);return m?m[1]:"";};',
            'var found=new Map();var stat={anchors:0,sig:0,state:0,api:0,net:0,rejected:0,routes:[]};',
            'var put=function(id,name,src){if(!id)return;var n=String(name||"").replace(/\\s+/g," ").trim().slice(0,40);',
            'if(!found.has(id)){found.set(id,n);if(src)stat[src]++;}else if(!found.get(id)&&n){found.set(id,n);}};',
            'var PFX="' + OPENID_B64_PREFIX + '";',
            'try{var H=document.documentElement.outerHTML;var re=new RegExp(PFX+"[A-Za-z0-9+/=_-]{8,}","g");var mm;',
            'while((mm=re.exec(H))){put(digits(mm[0]),"","sig");}}catch(e){}',
            'var KEYS=["uid","openid","intl_open_id","open_id"];',
            'document.querySelectorAll("a[href]").forEach(function(a){',
            'var u;try{u=new URL(a.getAttribute("href"),location.href);}catch(e){return;}',
            'var v="";for(var i=0;i<KEYS.length;i++){v=u.searchParams.get(KEYS[i]);if(v)break;}',
            'var id=digits(v);if(!id)return;',
            'var name=(a.textContent||"").trim();',
            'if(!name){var im=a.querySelector("img");name=im?(im.getAttribute("alt")||im.getAttribute("title")||""):"";}',
            'if(!name){var p=a.closest("li,tr,[class*=item],[class*=member],[class*=card]");name=p?(p.textContent||"").trim():"";}',
            'put(id,name,"anchors");});',
            'var seen=new Set();var walk=function(v,d,src){if(!v||d>10||typeof v!=="object")return;',
            'if(seen.has(v))return;seen.add(v);',
            // ★ ユニオン名を人の名前として拾わない (2026-09-09 実機: ギルド情報は
            //   「ユニオン名 + 団長の識別子」を持っているので、素直に組むと団長がユニオン名になる)
            'if(!Array.isArray(v)){var ik="",nk="",isG=false;',
            'for(var k in v){if(!ik&&/(^|_)(open_?id|uid)$/i.test(k)&&v[k])ik=k;',
            'if(/(guild|union|clan|team)_?id$/i.test(k)&&v[k])isG=true;',
            'if(!nk&&/(nick|user_?name|name)$/i.test(k)&&!/(guild|union|clan|team)/i.test(k)',
            '&&typeof v[k]==="string"&&v[k])nk=k;}',
            'if(isG&&nk&&/^name$/i.test(nk))nk="";',
            'if(ik){put(digits(v[ik]),nk?v[nk]:"",src);}}',
            'for(var k2 in v){try{walk(v[k2],d+1,src);}catch(e){}}};',
            'try{[W.__NUXT__,W.__NEXT_DATA__,W.__INITIAL_STATE__].forEach(function(s2){walk(s2,0,"state");});}catch(e){}',
            'var HD={"Content-Type":"application/json","X-Channel-Type":"2","X-Language":"ja",',
            '"X-Common-Params":JSON.stringify({game_id:"29080",area_id:"global",source:"pc_web",intl_game_id:"29080",language:"ja",env:"prod"})};',
            'var call=function(route,body2){var one=function(kind){return fetch("https://api.blablalink.com/api/game/"+kind+"/"+route,',
            '{method:"POST",credentials:"include",headers:HD,body:JSON.stringify(body2||{})}).then(function(r){return r.json();})',
            '.catch(function(){return null;});};',
            'return one("proxy").then(function(a){if(a&&a.code===0)return a;return one("direct");});};',
            'var idOf=function(o){var hit=null;var w2=function(v,d){if(hit||!v||d>8||typeof v!=="object")return;',
            'if(!Array.isArray(v)){for(var k in v){if(/(guild|union)_?id$/i.test(k)&&v[k]){hit=v[k];return;}}}',
            'for(var k3 in v){try{w2(v[k3],d+1);}catch(e){}}};w2(o,0);return hit;};',
            'var ROUTES=["Game/GetGuildDetail","Game/GetUnionRaidData","Game/GetGuildMemberList","Game/GetGuildMembers",',
            '"Game/GetUnionMemberList","Game/QueryGuildMemberList","Game/QueryGuildMembers","Game/GetGuildMemberInfo",',
            '"Game/QueryGuildCardDetail","Game/GetGuildUserList"];',
            'var run=async function(){',
            'var mine=await call("Game/GetMyGuildInfo");',
            'if(mine){stat.routes.push("GetMyGuildInfo:"+mine.code);walk(mine,0,"api");}',
            'var gid=mine?idOf(mine):null;',
            'var SHAPES=function(g){return g?[{guild_id:g,union_id:g},{guild_id:g,page:1,page_size:100},{intl_guild_id:g},{}]:[{}];};',
            'for(var i2=0;i2<ROUTES.length;i2++){var r3=ROUTES[i2];var sh=SHAPES(gid);var got=null;var last=null;',
            'for(var j2=0;j2<sh.length;j2++){var res=await call(r3,sh[j2]);if(!res)continue;last=res.code;',
            'if(res.code===0){got=res;break;}}',
            'stat.routes.push(r3.split("/")[1]+":"+(got?0:last));',
            'if(got)walk(got,0,"api");}',
            'var OWN=/(GetMyGuildInfo|GetGuildDetail|GetUnionRaidData|Member)/i;var NOT=/(Dynamics|Post|CardList|Tourist|Supporters)/i;',
            'var norm=S.bodies.map(function(b){return (b&&typeof b==="object")?{u:String(b.u||""),t:String(b.t||"")}:{u:"",t:String(b||"")};});',
            'var good=norm.filter(function(b){return OWN.test(b.u)&&!NOT.test(b.u);});',
            'var neutral=norm.filter(function(b){return !NOT.test(b.u);});',
            'var used=good.length?good:neutral;stat.rejected=norm.length-neutral.length;',
            'used.forEach(function(b){var t=b.t;try{walk(JSON.parse(t),0,"net");}catch(e){',
            'try{var r2=new RegExp(PFX+"[A-Za-z0-9+/=_-]{8,}","g"),m2;while((m2=r2.exec(t))){put(digits(m2[0]),"","net");}}catch(e2){}}});',
            'var out=[];var noname=0;',
            'found.forEach(function(n,id){if(n){out.push(n+"\\t"+id);}else{noname++;}});',
            'out.sort();',
            'var diag="\\n\\n---- \\u8a3a\\u65ad (\\u898b\\u3064\\u304b\\u3089\\u306a\\u3044\\u3068\\u304d\\u306f\\u3053\\u306e\\u4e0b\\u3054\\u3068\\u898b\\u305b\\u3066) ----\\naddress: "+location.href',
            '+"\\napi: "+stat.api+" ["+stat.routes.join(" ")+"]"',
            '+"\\nsignature: "+stat.sig+" / anchors: "+stat.anchors+" / state: "+stat.state',
            '+"\\nnetwork: "+stat.net+" / captured "+S.bodies.length+" / rejected: "+stat.rejected+" / noname: "+noname',
            '+"\\nheard: "+S.routes.slice(0,24).join(" ");',
            'L.length=0;',
            'box.value=(out.length?("\\u3057\\u308a\\u3059\\u3053PAD \\u540d\\u7c3f "+out.length+"\\u4eba\\n'
                + '\\u540d\\u524d\\u3068ID\\u3092\\u78ba\\u8a8d\\u3057\\u3066\\u3001\\u305d\\u306e\\u307e\\u307e\\u30b3\\u30d4\\u30fc\\u3057\\u3066PAD\\u306b\\u8cbc\\u3063\\u3066\\u304f\\u3060\\u3055\\u3044\\n\\n"+out.join("\\n"))',
            ':("\\u30e1\\u30f3\\u30d0\\u30fc\\u304c\\u898b\\u3064\\u304b\\u308a\\u307e\\u305b\\u3093\\u3067\\u3057\\u305f\\u3002"'
                + '+(noname?"\\n\\u540d\\u524d\\u306e\\u7121\\u3044\\u8b58\\u5225\\u5b50\\u306f "+noname+"\\u4ef6 \\u3042\\u308a\\u307e\\u3059\\u304c\\u3001\\u540d\\u524d\\u304c\\u7121\\u3044\\u3068\\u7a81\\u304d\\u5408\\u308f\\u305b\\u3089\\u308c\\u307e\\u305b\\u3093\\u3002":"")'
                + '+"\\n\\n\\u3053\\u306e\\u307e\\u307e\\u30e6\\u30cb\\u30aa\\u30f3\\u306e\\u30e1\\u30f3\\u30d0\\u30fc\\u4e00\\u89a7\\u3092\\u958b\\u3044\\u3066\\u3001\\u3082\\u3046\\u4e00\\u5ea6\\u62bc\\u3057\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002\\n\\u4e0a\\u306e api: \\u3068 heard: \\u306e\\u884c\\u3092\\u904b\\u55b6\\u306b\\u898b\\u305b\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002"))+diag;',
            'box.focus();box.select();try{document.execCommand("copy");}catch(e){}};',
            'run().catch(function(e){box.value="\\u9014\\u4e2d\\u3067\\u6b62\\u307e\\u308a\\u307e\\u3057\\u305f: "+(e&&e.message||e);});',
        ].join(''));
    }

    /**
     * 名簿の貼り付けを読む。「名前 <TAB> 識別子」の行 (見出しや空行は飛ばす)。
     * ★ 人が手で直すことを前提にする — タブでもカンマでも連続空白でも受ける。
     * ★ 名前が無い行 (識別子だけ) も拾う。名寄せは名前でやるが、手で当てることもできる。
     */
    function parseRoster(text) {
        const out = [];
        const seen = new Set();
        for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            // ★ タブがあればタブだけで割る (Codex指摘 2026-09-09) — 名前にカンマが入っていても壊さない。
            //   ブックマークレットの出力はタブ区切り。手で書いた行だけカンマ/連続空白に落ちる
            const parts = (line.includes('\t') ? line.split('\t') : line.split(/,|\s{2,}/))
                .map(s => s.trim()).filter(Boolean);
            if (!parts.length) continue;
            // 行の末尾が識別子。base64 で包まれたままでも開く
            const openid = parseOpenid(parts[parts.length - 1]);
            if (!openid) continue;
            const name = parts.length > 1 ? parts.slice(0, -1).join(' ').trim() : '';
            // ★ **同じ識別子を黙って捨てない** (Codex指摘) — 名前違いで2行あるのは名寄せの取り違えの元なので、
            //   matchRoster に判断させる。まったく同じ行 (二重貼り付け) だけ畳む
            const key = `${normName(name)}\u0001${openid}`;   // 名前と識別子を分けて畳む (区切りは制御文字)
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ name, openid });
        }
        return out;
    }

    /** 名前の突き合わせ用。全角半角・空白・大小文字の違いは同じ名前とみなす */
    const normName = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toLowerCase();

    /**
     * 名簿と PAD のメンバーを名前で突き合わせる。**判断はここだけ** (画面で書き足さない)。
     * @param {{name:string, openid:string}[]} entries  parseRoster の結果
     * @param {{id:any, name:string, blabla_openid?:string|null}[]} players
     * @returns {{apply:Object[], same:Object[], unmatched:Object[], missing:Object[], conflicts:Object[]}}
     *   apply     … ひも付けを変える (新規 or 付け替え)。prev があれば付け替え
     *   same      … すでに同じ識別子が付いている
     *   unmatched … 名簿にいるが PAD に同じ名前がいない (新加入・改名)
     *   missing   … PAD にいるが名簿にいない (脱退した可能性)
     *   conflicts … 同じ名前が PAD に2人以上 / 同じ識別子が名簿に2回。**自動で当てない**
     *   clear     … 付け替えの前に外す必要がある人 (識別子は1人にしか付けられないため)
     */
    function matchRoster(entries, players) {
        const es = Array.isArray(entries) ? entries : [];
        const ps = Array.isArray(players) ? players : [];
        const byName = new Map();
        for (const p of ps) {
            const k = normName(p && p.name);
            if (!k) continue;
            if (!byName.has(k)) byName.set(k, []);
            byName.get(k).push(p);
        }
        const apply = [], same = [], unmatched = [], conflicts = [];
        const hit = new Set();
        const claimed = new Map();   // playerId → 先にその人へ当たった行 (2行が同じ人に当たるのを防ぐ)
        // 同じ識別子が2回出てくる名簿は、どちらに当てるか決められない
        const idCount = new Map();
        for (const e of es) idCount.set(e.openid, (idCount.get(e.openid) || 0) + 1);
        for (const e of es) {
            const key = normName(e.name);
            const cand = key ? (byName.get(key) || []) : [];
            if (idCount.get(e.openid) > 1) {
                conflicts.push({ ...e, why: '同じ識別子が名簿に2回あります' });
                continue;
            }
            if (!cand.length) { unmatched.push(e); continue; }
            if (cand.length > 1) {
                conflicts.push({ ...e, why: `PAD に「${e.name}」が ${cand.length}人います` });
                cand.forEach(p => hit.add(String(p.id)));
                continue;
            }
            const p = cand[0];
            hit.add(String(p.id));
            // ★ 書き方の違う2行が同じ人に当たると、あとの行が黙って前の行を上書きする (Codex指摘 2026-09-09)。
            //   どちらが正しいかは決められないので、両方とも運営に返す
            const already = claimed.get(String(p.id));
            if (already) {
                conflicts.push({ ...e, why: `「${p.name}」に当たる行が名簿に2つあります (${already.openid} と ${e.openid})` });
                continue;
            }
            claimed.set(String(p.id), e);
            const prev = p.blabla_openid || null;
            if (prev === e.openid) same.push({ playerId: p.id, playerName: p.name, openid: e.openid });
            else apply.push({ playerId: p.id, playerName: p.name, openid: e.openid, prev });
        }
        const missing = ps.filter(p => !hit.has(String(p.id))).map(p => ({ playerId: p.id, playerName: p.name }));
        // ★ 識別子は1人にしか付けられない (部分一意索引)。付け替えるときは、いま持っている人を先に外さないと
        //   保存が 23505 で落ちる。メンバーの入れ替えが多い回ほどここに当たる (ユーザー要望 2026-09-09)
        const owner = new Map(apply.map(a => [a.openid, String(a.playerId)]));
        const clear = ps
            .filter(p => p.blabla_openid && owner.has(p.blabla_openid) && owner.get(p.blabla_openid) !== String(p.id))
            .map(p => ({ playerId: p.id, playerName: p.name, openid: p.blabla_openid }));
        return { apply, same, unmatched, missing, conflicts, clear };
    }

    /**
     * PAD のキャラ名 → BlaBlaLINK の name_code。ブックマークレットに埋める「取りたいキャラ」を決める。
     * ★ 対応表に無い名前は codes に入れず missing に出す — 黙って対象から外すと
     *   「そのキャラだけ取れていない」理由が分からなくなる (対応表に無い 3 体が実在する)。
     * @param {string[]} names  usedCharacters の結果
     * @param {Object} nameCodeMap  data/blabla-name-codes.json の data
     * @returns {{codes:number[], missing:string[]}}
     */
    function wantedCodesFor(names, nameCodeMap) {
        const byPad = new Map();
        for (const [code, v] of Object.entries(nameCodeMap || {})) {
            const pad = v && v.pad;
            if (!pad || byPad.has(pad)) continue;               // 先勝ち (対応表は生成時に衝突を止めている)
            const n = Number(code);
            if (Number.isFinite(n) && n > 0) byPad.set(pad, n);
        }
        const codes = [];
        const missing = [];
        const seen = new Set();
        for (const name of Array.isArray(names) ? names : []) {
            const key = typeof name === 'string' ? name : '';
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const code = byPad.get(key);
            if (code == null) missing.push(key);
            else codes.push(code);
        }
        return { codes: codes.sort((a, b) => a - b), missing: missing.sort() };
    }

    /**
     * 取り込み結果の内訳。B3 の「未公開 N 人」と「取れなかった人」の材料。
     * @param {{playerId:any, name:string, status:string, detail:string|null, count:number}[]} results
     */
    function importSummary(results) {
        const rs = Array.isArray(results) ? results : [];
        const by = { ok: [], private: [], no_openid: [], error: [] };
        for (const r of rs) {
            const k = r && by[r.status] ? r.status : 'error';
            by[k].push(r);
        }
        return {
            ok: by.ok.length, private: by.private.length, noOpenid: by.no_openid.length, error: by.error.length,
            characters: by.ok.reduce((s, r) => s + (Number(r.count) || 0), 0),
            failed: [...by.private, ...by.no_openid, ...by.error],
            byStatus: by,
        };
    }

    /**
     * 未公開の人への働きかけ (B3・2026-09-09)。
     * ★ 取れるのは BlaBlaLINK でゲームカードを公開している人だけで、同じユニオンでも突破できない。
     *   だから「取れなかった」を欠測にせず状態として残し、**本人に頼む**しかない。
     * ★ 声をかける相手は private の人だけ。未ひも付け (no_openid) は運営の作業待ちなので送らない。
     * ★ **ひも付けが外れている人にも言わない** (Codex指摘 2026-09-09)。状態が private のまま
     *   識別子だけ外されることがある (付け替えの途中など)。その人が公開しても、運営が識別子を
     *   付け直すまで取れないので、本人には何もできない = これも運営の作業待ち。
     *   → players には `blabla_openid` を載せて渡すこと (supabaseLoadPlayersWithOpenid の形)。
     * @param {{player_id:any, status:string}[]} statusRows
     * @param {{id:any, name:string, blabla_openid?:string|null}[]} players
     */
    function privateTargets(statusRows, players) {
        const priv = new Set((Array.isArray(statusRows) ? statusRows : [])
            .filter((r) => r && r.status === 'private').map((r) => String(r.player_id)));
        return (Array.isArray(players) ? players : [])
            .filter((p) => p && priv.has(String(p.id)) && p.blabla_openid);
    }

    /** 本人へのお願い。押す先はホーム (どこを触ればよいかは本文で言う) */
    const PUBLISH_ASK = {
        title: '🧬 育成データの公開のお願い',
        body: 'BlaBlaLINK でゲームカードを公開にすると、あなたの育成が「育成くらべ」に並びます。'
            + '公開していないと、運営からも他のメンバーからも見えません。設定 → ゲームカードの公開 をお願いします🙏',
        url: './?tab=ranking',
    };

    /** 戦闘力の読み方。並べて比べるので万単位に畳む (86.8万) */
    const fmtMan = (n) => (Number.isFinite(n) ? `${(n / 10000).toFixed(1)}万` : '—');
    /** オーバーロードの表示。合計も差もこれで揃える (単位が混ざると読めない) */
    const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}%` : '—');

    // ---- 「どのレイドを見ているか」(2026-09-09 実機FB) --------------------
    /**
     * 既定で見せる回。★ **本番の最新回**を選ぶ — 単に最大のシーズンを採ると、
     * 検証用のテスト回に取り込みの跡が1件でも残っていると、そこに引っ張られて
     * 「取り込み済み1人・他は未取得」に見える (実機FB 2026-09-09)。
     * @param {{id:any, is_test?:boolean, ok?:number}[]} seasons ok = 取り込めた人数
     */
    function defaultGrowthSeason(seasons) {
        const list = (Array.isArray(seasons) ? seasons : []).filter((s) => s && num(s.ok) > 0);
        const real = list.filter((s) => !s.is_test);
        const pick = (real.length ? real : list).slice()
            .sort((a, b) => Number(b.id) - Number(a.id))[0];
        return pick ? Number(pick.id) : null;
    }

    /**
     * その人が**この回で実際に使った編成**を凸記録から集める。
     * ★ 盤面の loadoutsByAttr は「アクティブシーズンの模擬編成」なので使わない —
     *   終わったレイドを振り返っているのに、別の回の模擬が出ていた (実機FB 2026-09-09)。
     * 同じ5人 (順不同) の凸はまとめ、いちばん大きいダメージを代表にする。
     * @returns {{team:string[], bossNo:number, bossCode:string, dmg:number, count:number}[]} ダメージの大きい順
     */
    function usedTeams(attacks, playerId) {
        const seen = new Map();
        for (const a of Array.isArray(attacks) ? attacks : []) {
            if (!a || playerId == null || String(a.player_id) !== String(playerId)) continue;
            const team = (Array.isArray(a.characters) ? a.characters : [])
                .map((c) => (typeof c === 'string' ? c : (c && c.name)))
                .filter((c) => typeof c === 'string' && c.trim())
                .map((c) => c.trim());
            if (!team.length) continue;
            const key = team.slice().sort().join('\n');
            const dmg = num(a.damage_raw);
            if (!seen.has(key)) {
                seen.set(key, { team, bossNo: num(a.boss_number), bossCode: String(a.boss_code || ''), dmg: -1, count: 0 });
            }
            const e = seen.get(key);
            e.count++;
            if (dmg > e.dmg) { e.dmg = dmg; e.bossNo = num(a.boss_number); e.bossCode = String(a.boss_code || ''); }
        }
        return [...seen.values()].map((e) => ({ ...e, dmg: Math.max(0, e.dmg) }))
            .sort((x, y) => y.dmg - x.dmg);
    }

    /** 育成行 → { プレイヤーid: { キャラ名: 行 } }。ユニオン全体を1回で引けるようにする */
    function byPlayerCharacter(rows) {
        const out = {};
        for (const r of Array.isArray(rows) ? rows : []) {
            if (!r || r.player_id == null || !r.character_name) continue;
            const k = String(r.player_id);
            if (!out[k]) out[k] = {};
            // ★ ここが育成データを読む唯一の入口。旧キー (属性ダメージ) をここで寄せておくと、
            //   下流 (比較・順位・チップ) が混在を気にしなくてよい
            // ★ null は null のまま残す。{} にすると「オーバーロードを持っていない (=0)」に化け、
            //   未取得の人が 0 として順位に混ざる (Codex指摘 2026-09-09)。
            //   {} は「取り込めたが1枠も無い」= 本当に 0 なので、それとは区別する
            if (!out[k][r.character_name]) {
                out[k][r.character_name] = { ...r, overload: r.overload == null ? null : normalizeOverload(r.overload) };
            }
        }
        return out;
    }

    /** その回に取り込めているキャラ名 (五十音順)。キャラえらびの元 */
    function charactersIn(rows) {
        return [...new Set((Array.isArray(rows) ? rows : [])
            .map((r) => r && r.character_name).filter(Boolean))]
            .sort((a, b) => String(a).localeCompare(String(b), 'ja'));
    }

    /** 並べ替えに使える項目。★ 画面に項目名を持たせない (compare と食い違わせない) */
    // 並べ替えのピルは「見たい順」に出す — 合計 → オーバーロード各種 → その他
    const SORT_FIELDS = [SUM_FIELD, ...OVERLOAD_FIELDS, ...FIELDS].map((f) => ({ key: f.key, label: f.label }));
    /** 既定の並べ替え。戦闘力ではなくオーバーロード合計 (シンクロレベル順にならない) */
    const DEFAULT_SORT = SUM_FIELD_KEY;
    const _fieldOf = (key) => ALL_FIELDS.find((f) => f.key === key) || SUM_FIELD;

    /**
     * 1体のキャラを**ユニオン内で並べる** (2026-09-09 ユーザー要望)。
     * ★ 持っていない人・その項目が欠けている人は出さない — 0 として最下位に並べると
     *   「持っているが育っていない」と区別が付かない。
     * @returns {{field:{key:string,label:string}, list:Object[], myRank:number|null}}
     */
    function unionRanking(byPl, players, characterName, fieldKey, myId) {
        const f = _fieldOf(fieldKey);
        const list = (Array.isArray(players) ? players : []).map((p) => {
            if (!p || p.id == null) return null;
            const row = ((byPl || {})[String(p.id)] || {})[characterName] || null;
            const value = row ? f.value(row) : null;
            return value == null ? null
                : { playerId: p.id, name: String(p.name == null ? '' : p.name), row, value, text: f.text(row) };
        // ★ 同点は名前 → id で固定する。名前だけだと**同名のメンバー**同士で渡す順に左右され、
        //   描き直すたびに順位が入れ替わる (Codex指摘 2026-09-09)
        }).filter(Boolean).sort((a, b) => b.value - a.value
            || a.name.localeCompare(b.name, 'ja')
            || String(a.playerId).localeCompare(String(b.playerId)));
        const at = list.findIndex((x) => myId != null && String(x.playerId) === String(myId));
        return { field: { key: f.key, label: f.label }, list, myRank: at < 0 ? null : at + 1 };
    }

    /**
     * 編成の5体を**編成の並びのまま**くらべる (アイコンの下に出す差)。
     * ★ 並べ替えるのは rankSquad の仕事。ここで並べ替えると編成の見た目が崩れる。
     */
    function teamGaps(team, mineByName, theirsByName) {
        return (Array.isArray(team) ? team : []).filter(Boolean).map((name) => {
            const a = (mineByName || {})[name] || null;
            const b = (theirsByName || {})[name] || null;
            const am = SUM_FIELD.value(a), bm = SUM_FIELD.value(b);
            return {
                character: name, mine: am, theirs: bm,
                hasBoth: am != null && bm != null,
                gap: (am == null || bm == null) ? null : bm - am,
            };
        });
    }

    /**
     * 編成ぶんを**差の大きい順**に並べ、先に読む結論を添える (2026-09-09 モックの決定 C)。
     * ★ 9項目 × 5体を全部並べても差がどこにあるか読めない。並び順と要約が読み方そのもの。
     * @returns {{cells:Object[], summary:Object}}
     *   cells[].gap        戦闘力の差 (相手 − 自分)。片方でも欠けたら null
     *   cells[].diffs      差のある項目だけ (同じ項目は出さない)
     *   summary.aheadTheirs/aheadMine  何体で上か (両方そろっている体だけ数える)
     */
    function rankSquad(squad, mineByName, theirsByName) {
        const cells = compareSquad(squad, mineByName, theirsByName).map((c) => {
            const m = (mineByName || {})[c.character] || null;
            const t = (theirsByName || {})[c.character] || null;
            // ★ 上下の基準は**オーバーロード合計 (有利コード＋攻撃)**。
            //   戦闘力で並べるとシンクロレベル順にしかならず、育成の差が読めない (2026-09-09 ユーザー指摘)。
            //   戦闘力は項目のひとつとして表に残す
            const cm = SUM_FIELD.value(m);
            const ct = SUM_FIELD.value(t);
            return {
                ...c,
                scoreMine: cm, scoreTheirs: ct,
                combatMine: val(m && m.combat), combatTheirs: val(t && t.combat),
                // ★ 「行がある」と「比べられる」は別 (Codex指摘 2026-09-09)。
                //   行はあるが値が欠けている体を「互角」に数えると、カードの「比べられない」と食い違う
                comparable: cm != null && ct != null,
                gap: (cm == null || ct == null) ? null : Number((ct - cm).toFixed(4)),
                hasBoth: !!(m && t),
                // ★ 差のある項目だけ。「同じ」を並べても読む手がかりにならない。
                //   戦闘力は横棒と差のピルで既に出しているのでチップにはしない (Codex指摘)
                // ★ 差のある項目だけ。「同じ」を並べても読む手がかりにならない。
                //   戦闘力はシンクロレベルの差がそのまま出るだけなのでチップにしない (2026-09-09)
                diffs: c.rows.filter((r) => (r.lead === 'mine' || r.lead === 'theirs') && r.key !== 'combat'),
            };
        });
        // 相手が大きく上のものから。比べられない体 (片方欠け) は最後に回す
        const sorted = cells.slice().sort((a, b) => {
            if (a.gap == null && b.gap == null) return 0;
            if (a.gap == null) return 1;
            if (b.gap == null) return -1;
            return b.gap - a.gap;
        });
        // ★ 合計は**比べられる体だけ**で出す (Codex指摘 2026-09-09)。
        //   片方にしか無い体を混ぜると、違う顔ぶれの合計を並べて「差」と言うことになる
        const cmp = cells.filter((c) => c.comparable);
        const sum = (list, k) => list.reduce((s, c) => s + (c[k] || 0), 0);
        return {
            cells: sorted,
            summary: {
                total: cells.length,
                comparable: cmp.length,
                aheadTheirs: cmp.filter((c) => c.gap > 0).length,
                aheadMine: cmp.filter((c) => c.gap < 0).length,
                // ★ 合計もオーバーロード基準。戦闘力の合計はシンクロレベルの差が5体ぶん積み上がるだけ
                sumMine: Number(sum(cmp, 'scoreMine').toFixed(4)),
                sumTheirs: Number(sum(cmp, 'scoreTheirs').toFixed(4)),
                diff: Number((sum(cmp, 'scoreTheirs') - sum(cmp, 'scoreMine')).toFixed(4)),
            },
        };
    }

    /** 今回のレイドで使われたキャラを、凸記録から集める (取り込む対象を決めるのに使う)。 */
    function usedCharacters(attacks) {
        const out = new Set();
        for (const a of Array.isArray(attacks) ? attacks : []) {
            for (const c of Array.isArray(a && a.characters) ? a.characters : []) {
                const name = typeof c === 'string' ? c : (c && c.name);
                if (name) out.add(name);
            }
        }
        return [...out].sort();
    }

    root.growthDomain = {
        OVERLOAD_JP, OVERLOAD_ALIAS, OVERLOAD_ORDER, OVERLOAD_FIELDS, SUM_FIELD, ALL_FIELDS,
        normalizeOverload, overloadValue, DEFAULT_SORT, SUM_FIELD_KEY, OL_PREFIX,
        PARTS, STATUS_JP, STATUS_SHORT, FIELDS, CORP_TIER, MAX_GRADE, MAX_CORE,
        growthRank, gradeText, buildOptionMap, overloadTotals, overloadSlotCount, unresolvedOptions,
        equipOf, toRows, statusOfCode, compare, compareSquad, usedCharacters,
        parseOpenid, wantedCodesFor, importSummary,
        IMPORT_PREFIX, AREAS, buildImportSnippet, parseImportPayload, prepareMember,
        buildRosterSnippet, parseRoster, matchRoster, normName, OPENID_B64_PREFIX,
        rankSquad, fmtMan, fmtPct, privateTargets, PUBLISH_ASK,
        defaultGrowthSeason, usedTeams, byPlayerCharacter, charactersIn,
        SORT_FIELDS, unionRanking, teamGaps,
    };
})(typeof window !== 'undefined' ? window : globalThis);
