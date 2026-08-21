// ============================================================================
// BlaBlaLINK 図鑑アイコン収集ブックマークレット (v2 — 2026-08-21 名前取得を修理)
// ----------------------------------------------------------------------------
// 使い方:
//   1. 下の「1行版」をブックマークのURLに登録する (javascript: から行末まで全部)
//   2. BlaBlaLINK のキャラ図鑑 (ニケ一覧) を開き、一番上で起動
//   3. 自動でスクロールして収集 → list.json がダウンロードされる
//
// v1 の問題 (2026-08-20 に発覚):
//   名前を「img.alt → 祖先の .role-name」で取っていたが、ページ改修で
//   .role-name が戦闘力 (Pow.404770) を持つようになり、全キャラの name が
//   Pow.xxx になった。436枚を目視で仕分ける羽目になった。
//
// v2 の方針 — セレクタに依存しない:
//   1. 「カード範囲」を決める: 画像の祖先を、CDN画像を2枚以上含む手前まで登る。
//      こうすると隣のキャラの名前を拾わない
//   2. カード内の可視テキスト行から「名前らしいもの」を選ぶ:
//      Pow.xxx / 数値だけ / Lv.xx / % / 30文字超 を除外し、
//      日本語を含む行を優先、無ければ短い英数字 (2B, A2, K など)
//   3. ★ 候補行を texts として全部保存する — ヒューリスティックが外れても
//      list.json を見れば手動マッピングできる (v1 の「名前が全滅すると詰む」を防ぐ)
// ============================================================================

// ---- 読みやすい版 (ロジック確認用。実行するのは下の1行版) ----
(async () => {
    const seen = new Map();   // url -> {name, texts}
    const CDN = 'sg-tools-cdn.blablalink.com';

    // 画像1枚だけを含む最大の祖先 = そのキャラのカード
    const findCard = (img) => {
        let el = img.parentElement, last = img;
        for (let i = 0; i < 10 && el; i++) {
            if (el.querySelectorAll(`img[src*="${CDN}"]`).length > 1) break;
            last = el; el = el.parentElement;
        }
        return last;
    };
    const badText = (t) =>
        /^pow[.,]?[\d,]+$/i.test(t) || /^[\d,.\s]+$/.test(t) || /^lv\.?\s*\d+$/i.test(t)
        || /^[+\-]?\d+([.,]\d+)?\s*%$/.test(t) || t.length > 30;
    const nameFrom = (img) => {
        const card = findCard(img);
        const texts = [...new Set(
            String(card.innerText || '').split('\n').map(t => t.trim()).filter(Boolean)
        )].filter(t => !badText(t));
        const jp = texts.filter(t => /[぀-ヿ一-鿿]/.test(t));
        const pool = jp.length ? jp : texts.filter(t => t.length <= 12);
        const name = pool.slice().sort((a, b) => a.length - b.length)[0] || '';
        return { name, texts: texts.slice(0, 6) };
    };
    const collect = () => {
        document.querySelectorAll(`img[src*="${CDN}"]`).forEach(img => {
            const s = img.currentSrc || img.src;
            if (!s) return;
            const cur = seen.get(s);
            if (cur && cur.name) return;          // 既に名前つきで取れているなら据え置き
            const r = nameFrom(img);
            if (!cur || r.name) seen.set(s, r);
        });
    };

    // 一番大きいスクロール領域を末尾まで送りながら収集 (v1 と同じ)
    const scroller = [...document.querySelectorAll('*')]
        .filter(e => e.scrollHeight > e.clientHeight + 100 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement;
    let stable = 0, last = 0;
    while (stable < 6) {
        scroller.scrollTop += scroller.clientHeight * 0.8;
        await new Promise(r => setTimeout(r, 700));
        collect();
        if (seen.size === last) stable++; else { stable = 0; last = seen.size; }
    }
    collect();

    const list = [...seen].map(([url, r]) => ({ url, name: r.name, texts: r.texts }));
    const named = list.filter(x => x.name).length;
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'list.json';
    a.click();
    alert(`完了: 名前あり ${named} 件 / 全画像 ${list.length} 件。list.json を保存しました。` +
        (named < list.length * 0.3 ? '\n⚠ 名前の取得率が低いです。list.json の texts を添えて相談してください' : ''));
})();

// ---- 1行版 (これをブックマークのURLへ) ----
// javascript:(async()=>{const seen=new Map(),CDN='sg-tools-cdn.blablalink.com';const findCard=g=>{let el=g.parentElement,last=g;for(let i=0;i<10&&el;i++){if(el.querySelectorAll('img[src*="'+CDN+'"]').length>1)break;last=el;el=el.parentElement}return last};const bad=t=>/^pow[.,]?[\d,]+$/i.test(t)||/^[\d,.\s]+$/.test(t)||/^lv\.?\s*\d+$/i.test(t)||/^[+\-]?\d+([.,]\d+)?\s*%$/.test(t)||t.length>30;const nameFrom=g=>{const card=findCard(g);const texts=[...new Set(String(card.innerText||'').split('\n').map(t=>t.trim()).filter(Boolean))].filter(t=>!bad(t));const jp=texts.filter(t=>/[぀-ヿ一-鿿]/.test(t));const pool=jp.length?jp:texts.filter(t=>t.length<=12);const name=pool.slice().sort((a,b)=>a.length-b.length)[0]||'';return{name,texts:texts.slice(0,6)}};const collect=()=>{document.querySelectorAll('img[src*="'+CDN+'"]').forEach(g=>{const s=g.currentSrc||g.src;if(!s)return;const cur=seen.get(s);if(cur&&cur.name)return;const r=nameFrom(g);if(!cur||r.name)seen.set(s,r)})};const scroller=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+100&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0]||document.scrollingElement;let stable=0,last=0;while(stable<6){scroller.scrollTop+=scroller.clientHeight*0.8;await new Promise(r=>setTimeout(r,700));collect();if(seen.size===last)stable++;else{stable=0;last=seen.size}}collect();const list=[...seen].map(([url,r])=>({url,name:r.name,texts:r.texts}));const named=list.filter(x=>x.name).length;const blob=new Blob([JSON.stringify(list,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='list.json';a.click();alert('完了: 名前あり '+named+' 件 / 全画像 '+list.length+' 件。list.json を保存しました。'+(named<list.length*0.3?'\n⚠ 名前の取得率が低いです。list.json の texts を添えて相談してください':''))})();
