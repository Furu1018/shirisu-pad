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
        IncElementDmg: '属性ダメージ',
        StatAmmoLoad: '装弾数',
        StatCritical: 'クリティカル確率',
        StatCriticalDamage: 'クリティカルダメージ',
        StatChargeTime: 'チャージ速度',
        StatChargeDamage: 'チャージダメージ',
        StatAccuracyCircle: '命中率',
        IncHurtDef: '防御力',
        StatDef: '防御力',
    };

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
                lv: pick(detail.lv, base.lv),
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

    // ---- 取り込み ---------------------------------------------------------
    /** 取り込んだデータの目印。しりすこスクワッドの NKP1-/NKU1- と混ざらないよう別にする。 */
    const IMPORT_PREFIX = 'SPG1-';
    /** 公式サーバー。日本を先に見る (ほとんどが日本サーバー)。 */
    const AREAS = [81, 83, 84, 82, 85];

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
        return 'javascript:(function(){' + [
            'var D=' + JSON.stringify(D) + ';',
            'var box=document.createElement("textarea");',
            'box.setAttribute("style","position:fixed;top:4%;left:4%;width:92%;height:70%;z-index:2147483647;'
                + 'background:#03090f;color:#e8f6f5;font:12px monospace;padding:10px;border:2px solid #45d6d0");',
            'document.body.appendChild(box);',
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
        ].join('') + '})()';
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
        { key: 'harmony_cube_lv', label: 'キューブ', text: (r) => lvText(r.harmony_cube_lv), value: (r) => val(r.harmony_cube_lv) },
        { key: 'favorite_item_lv', label: 'お気に入り', text: (r) => lvText(r.favorite_item_lv), value: (r) => val(r.favorite_item_lv) },
    ];

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
        const keys = [...new Set([
            ...Object.keys((mine && mine.overload) || {}),
            ...Object.keys((theirs && theirs.overload) || {}),
        ])].sort();
        const overload = keys.map((k) => {
            const a = mine && mine.overload ? Number(mine.overload[k] || 0) : null;
            const b = theirs && theirs.overload ? Number(theirs.overload[k] || 0) : null;
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
        OVERLOAD_JP, PARTS, STATUS_JP, FIELDS, CORP_TIER, MAX_GRADE, MAX_CORE,
        growthRank, gradeText, buildOptionMap, overloadTotals, overloadSlotCount, unresolvedOptions,
        equipOf, toRows, statusOfCode, compare, compareSquad, usedCharacters,
        IMPORT_PREFIX, AREAS, buildImportSnippet, parseImportPayload, prepareMember,
    };
})(typeof window !== 'undefined' ? window : globalThis);
