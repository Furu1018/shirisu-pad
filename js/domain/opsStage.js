// ============================================================================
// ドメイン: 運営モードの「段階」— 準備 / 前日 / 当日 / 終了 (運営UI再設計 2026-09-08)
// ----------------------------------------------------------------------------
// 「情報量が多すぎて使いにくい」(ユーザー) → 運営タブの主語をカードから段階へ。
//   準備 (シーズンが無い) → 前日 (作成後〜ハード日の前日) → 当日 (ハード日 5時〜翌4時) → 終了 (翌日以降・まだ終了していない)
// 段階は自動で決める (detect)。テストのために運営が手動で上書きできる (override・端末ごと・シーズンごと)。
// ここは純ロジックだけ: 段階の判定 / カードの出し分け / チェックリスト / ヒーロー (いちばん急ぐ1つ)。DOM は index.html。
//
// ★ レイド日は 5時〜翌4時 (availability.js と同じ)。0時で日付が変わっても当日は続いている。
// ★ 「終了」= ハード日を過ぎたのにシーズンがまだアクティブ。終了処理をすると自動で「準備」に戻る。
//
// optimal-plan.js と同じ規約: IIFE + root 直付け。DOM 非依存で node からテスト可能:
//   node tests/run-tests.mjs
// ============================================================================
(function (root) {
    'use strict';

    const STAGES = ['prep', 'pre', 'day', 'end'];
    const STAGE_JP = { prep: '準備', pre: '前日', day: '当日', end: '終了' };
    const STAGE_SUB = { prep: 'シーズンが無い', pre: '作成後 〜 ハード日の前日', day: 'ハード日 5時 〜 翌4時', end: 'ハード日の翌日以降' };
    const STORAGE_KEY = 'shirisuko_ops_stage_override_v1';
    const RAID_DAY_START_HOUR = 5;
    const MAX_ATTACKS = 3;

    /** その時刻の JST の日付 'YYYY-MM-DD' (端末のタイムゾーンに依存しない) */
    function jstDate(now) {
        const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
        const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' });
        const p = Object.fromEntries(f.formatToParts(d).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        return `${p.year}-${p.month}-${p.day}`;
    }
    /** レイド日のキー: 5時より前は前日のレイド日 (翌4時までが同じ日) */
    function raidDayKey(now) {
        const ms = (now instanceof Date ? now : new Date(now == null ? Date.now() : now)).getTime();
        return jstDate(ms - RAID_DAY_START_HOUR * 3600 * 1000);
    }

    const isStage = (s) => STAGES.includes(s);

    /**
     * 段階の判定。
     * @param {{season?:Object|null, now?:number|Date, override?:string|null}} args
     * @returns {{stage:string, auto:string, overridden:boolean}}
     */
    function detect({ season, now, override } = {}) {
        let auto;
        if (!season || season.is_active === false) auto = 'prep';
        else if (!season.hard_date) auto = 'pre';
        else {
            const key = raidDayKey(now);
            const hd = String(season.hard_date).slice(0, 10);
            auto = key < hd ? 'pre' : key === hd ? 'day' : 'end';
        }
        const ov = isStage(override) ? override : null;
        return { stage: ov || auto, auto, overridden: !!ov && ov !== auto };
    }

    /** 手動上書きの記憶 (端末ごと・シーズンごと)。別のシーズンの記憶は捨てる */
    function parseOverride(raw, seasonId) {
        try {
            const v = JSON.parse(raw || 'null');
            if (!v || typeof v !== 'object' || !isStage(v.stage)) return null;
            if (seasonId != null && String(v.seasonId) !== String(seasonId)) return null;
            return v.stage;
        } catch { return null; }
    }
    function serializeOverride(seasonId, stage) {
        return isStage(stage) ? JSON.stringify({ seasonId: seasonId == null ? null : String(seasonId), stage }) : null;
    }
    const nextOf = (s) => STAGES[Math.min(STAGES.length - 1, STAGES.indexOf(s) + 1)] || s;
    const prevOf = (s) => STAGES[Math.max(0, STAGES.indexOf(s) - 1)] || s;

    /** カードをこの段階で出すか。stages が無いカードは全段階 */
    function visibleIn(card, stage) {
        if (!card) return true;
        if (!Array.isArray(card.stages)) return true;
        return card.stages.includes(stage);
    }

    // ---- チェックリスト ---------------------------------------------------------
    /** ボスの設定が済んでいるか (属性・弱点・HP) */
    function bossReady(b) {
        if (!b) return false;
        const hp = Number(b.total_hp_raw) || Number(b.max_hp_raw) || Number(b.hp_raw) || Number(b.remaining_hp_raw) || 0;
        return !!(b.attribute && b.weakness && hp > 0);
    }

    /**
     * 段階ごとの「やること」。数えられないもの (未ロード・未適用) は pending=true で出す (0 と混同させない)。
     * @param {Object} a
     * @param {string} a.stage
     * @param {Object|null=} a.season
     * @param {Object[]=} a.bosses
     * @param {Object[]|null=} a.mbRows          memberStatusDomain.buildRows の結果 (未ロードなら null)
     * @param {{pending:number, approved:number}|null=} a.reservations
     * @param {boolean|null=} a.published        配信中プランがあるか (null = 不明)
     * @param {number=} a.pendingRepublish       配信後に固定された予約の数
     * @param {string|null=} a.backupSavedAt     最後にバックアップを保存した時刻 (ISO・端末の記憶)
     * @returns {{key:string,label:string,value:any,total:number|null,done:boolean,pending:boolean,action:string|null,nudge:string|null,optional:boolean}[]}
     */
    function checklist({ stage, season, bosses, mbRows, reservations, published, pendingRepublish, backupSavedAt } = {}) {
        const row = (o) => ({ total: null, done: false, pending: false, action: null, nudge: null, optional: false, ...o });
        if (stage === 'pre') {
            const bs = Array.isArray(bosses) ? bosses : [];
            const ready = bs.filter(bossReady).length;
            const rows = [row({ key: 'bosses', label: 'ボスの属性と HP', value: ready, total: 5, done: ready >= 5, action: 'season-edit' })];
            const rs = Array.isArray(mbRows) ? mbRows : null;
            const n = rs ? rs.length : 0;
            if (rs) {
                const mock = rs.filter(r => r.mockOk).length;
                rows.push(row({ key: 'mock', label: '模擬の提出 (3属性・被りなし)', value: mock, total: n, done: mock >= n, nudge: 'mock', action: 'members' }));
                const supported = rs.some(r => r.availSupported);
                const avail = supported ? rs.filter(r => r.availConfirmed).length : rs.filter(r => (r.slots && r.slots.length > 0) || r.flex).length;
                rows.push(row({ key: 'avail', label: supported ? '戦闘可能時間の確認' : '戦闘可能時間の登録', value: avail, total: n, done: avail >= n, nudge: 'avail', action: 'members' }));
                const off = rs.filter(r => !r.push).length;
                rows.push(row({ key: 'push', label: '通知 OFF の人', value: off, total: null, done: off === 0, action: 'notify' }));
            } else {
                rows.push(row({ key: 'mock', label: '模擬の提出 (3属性・被りなし)', value: null, pending: true, nudge: 'mock', action: 'members' }));
                rows.push(row({ key: 'avail', label: '戦闘可能時間の確認', value: null, pending: true, nudge: 'avail', action: 'members' }));
                rows.push(row({ key: 'push', label: '通知 OFF の人', value: null, pending: true, action: 'notify' }));
            }
            if (reservations) {
                const p = Number(reservations.pending) || 0;
                rows.push(row({ key: 'resv', label: '予約の承認', value: p === 0 ? '待ちなし' : `承認待ち ${p}`, done: p === 0, action: 'reserve' }));
            } else {
                rows.push(row({ key: 'resv', label: '予約の承認', value: null, pending: true, action: 'reserve' }));
            }
            const rp = Number(pendingRepublish) || 0;
            if (published == null) rows.push(row({ key: 'publish', label: 'プランを配信', value: null, pending: true, action: 'plan' }));
            else if (rp > 0) rows.push(row({ key: 'publish', label: 'プランを配信し直す', value: `配信後の予約 ${rp}`, done: false, action: 'republish' }));
            else rows.push(row({ key: 'publish', label: 'プランを配信', value: published ? '配信中' : '未', done: !!published, action: 'plan' }));
            return rows;
        }
        if (stage === 'end') {
            const hd = season && season.hard_date ? String(season.hard_date).slice(0, 10) : null;
            const saved = !!backupSavedAt && (!hd || String(backupSavedAt).slice(0, 10) >= hd);
            return [
                row({ key: 'backup', label: 'バックアップを保存', value: saved ? '保存済み' : '未', done: saved, action: 'backup' }),
                row({ key: 'end', label: 'シーズンを終了', value: '未', done: false, action: 'end' }),
                row({ key: 'reset', label: '模擬ダメージのリセット', value: '任意', done: false, optional: true, action: 'reset' }),
            ];
        }
        return [];
    }

    // ---- ヒーロー (いちばん急ぐ1つ) ----------------------------------------------
    const fmtAgo = (min) => min == null ? '—' : min < 1 ? 'たった今' : min < 60 ? `${min}分前` : `${Math.floor(min / 60)}時間前`;

    /**
     * @param {Object} a
     * @param {string} a.stage
     * @param {Object|null=} a.season
     * @param {Object[]=} a.rows            checklist の結果
     * @param {{pending:number}|null=} a.reservations
     * @param {number=} a.pendingRepublish
     * @param {number|null=} a.freshMin     HP更新からの分 (当日)
     * @param {number=} a.remainingTotal    残凸の合計 (当日)
     * @param {number|null=} a.finPending   締め凸未返答 (当日)
     * @param {number=} a.attacksDone       当日〜終了: 実凸の合計
     * @param {number=} a.attackCap         定員×3
     * @returns {{lead:string, why:string, action:string, label:string}}
     */
    function hero({ stage, season, rows, reservations, pendingRepublish, freshMin, remainingTotal, finPending, attacksDone, attackCap } = {}) {
        const rp = Number(pendingRepublish) || 0;
        const rvP = reservations ? Number(reservations.pending) || 0 : 0;
        if (stage === 'prep') {
            return { lead: 'シーズンを作ると、提出・予約・プランが動き出します', why: 'ボス 5 体の属性と HP、ハード日を入れます。作るまでは他の操作は要りません', action: 'create', label: '🗓 シーズンを作る' };
        }
        if (stage === 'pre') {
            if (rvP > 0) return { lead: `🔒 承認待ちの予約が ${rvP} 件あります`, why: '承認するとその凸は固定され、プランを組み直します。最後の 1 件で配信へ進みます', action: 'reserve', label: '🔒 予約を見る' };
            if (rp > 0) return { lead: '🔒 配信後の予約があります、確認して下さい', why: `承認した予約 ${rp} 件がいまの配信に入っていません。固定して組み直し、配信し直してください`, action: 'republish', label: '🧮 固定して組み直す → 配信' };
            const rs = Array.isArray(rows) ? rows : [];
            const next = rs.find(r => !r.done && !r.pending && !r.optional);
            if (!next) {
                const anyPending = rs.some(r => r.pending);
                return anyPending
                    ? { lead: '状況を読み込んでいます', why: 'メンバー状況と予約が読めると、ここに次にやることが出ます', action: 'members', label: '👥 メンバー状況を見る' }
                    : { lead: '✅ 配信済み。あとは当日を待つだけです', why: '提出・時間帯・通知がそろい、プランも配信しています。変更があればここに出ます', action: 'plan', label: '📤 配信を見る' };
            }
            const left = (next.total != null && typeof next.value === 'number') ? next.total - next.value : null;
            switch (next.key) {
                case 'bosses': return { lead: `ボスの属性と HP が未設定です (${next.value}/5)`, why: '5 体そろわないとプランを算出できません', action: 'season-edit', label: '✏️ シーズンを編集する' };
                case 'mock': return { lead: `模擬の提出が残り ${left} 人`, why: '3 属性・キャラ被りなしの提出がプランの材料です。催促は通知を購読している人にだけ届きます', action: 'nudge:mock', label: '📣 未提出の人に催促する' };
                case 'avail': return { lead: `戦闘可能時間の確認が残り ${left} 人`, why: '前回のままの人は確認ボタン 1 つで終わります。時間が分からないとプランに乗りません', action: 'nudge:avail', label: '📣 未確認の人に催促する' };
                case 'push': return { lead: `通知 OFF の人が ${next.value} 人います`, why: '通知が無いと配信・締め凸依頼・時間帯の開始が届きません。Discord で声をかけてください', action: 'notify', label: '🔔 誰が OFF か見る' };
                case 'resv': return { lead: `🔒 承認待ちの予約が ${next.value}`, why: '承認するとその凸は固定されます', action: 'reserve', label: '🔒 予約を見る' };
                case 'publish': return { lead: '📤 プランを配信しましょう', why: '算出 → 差分の確認 → 配信 → Discord テンプレの順に進みます', action: 'plan', label: '🧮 算出して配信する' };
                default: return { lead: next.label, why: '', action: next.action || 'members', label: '開く' };
            }
        }
        if (stage === 'day') {
            if (freshMin != null && freshMin >= 30) return { lead: `HP 更新が ${fmtAgo(freshMin)} です`, why: '古い HP で締め凸を出すと、無駄凸や取りこぼしが出ます', action: 'hp', label: '🎯 ボス HP を更新する' };
            if ((Number(finPending) || 0) > 0) return { lead: `締め凸の返答待ちが ${finPending} 件`, why: '返答が無いと締めの割当が決まりません', action: 'members', label: '👥 返答待ちを見る' };
            if (rvP > 0) return { lead: `🔒 承認待ちの予約が ${rvP} 件あります`, why: '当日の予約は承認するとすぐ固定されます', action: 'reserve', label: '🔒 予約を見る' };
            if (rp > 0) return { lead: '🔒 配信後の予約があります、確認して下さい', why: `承認した予約 ${rp} 件がいまの配信に入っていません`, action: 'republish', label: '🧮 組み直して再配信' };
            const rem = Number(remainingTotal) || 0;
            if (rem > 0) return { lead: `残り ${rem} 凸`, why: '残り戦闘可能メンバーから、いま出られる人と締め凸を見ます', action: 'remaining', label: '👥 残りメンバーを見る' };
            return { lead: '🎉 全員 3 凸完了', why: '翌日になったら終了処理へ進みます', action: 'end', label: '🏁 終了処理へ' };
        }
        if (stage === 'end') {
            const done = Number(attacksDone) || 0, cap = Number(attackCap) || 0;
            return { lead: `お疲れさまでした。${done} 凸${cap ? ` / ${cap}` : ''}`, why: 'バックアップを保存してからシーズンを終了します。終了するとホームは結果になり、次のシーズンを作れます', action: 'end', label: '🏁 シーズンを終了する' };
        }
        return { lead: '', why: '', action: 'members', label: '' };
    }

    /** 催促の対象 (前日): 理由キーで絞り、通知を購読していて「今回は難しい」でない人 */
    function nudgeTargets(mbRows, kind) {
        const rs = Array.isArray(mbRows) ? mbRows : [];
        const keysFor = kind === 'mock' ? ['mock'] : kind === 'avail' ? ['slots', 'availConfirm', 'availChanged'] : [];
        return rs.filter(r => r && r.push && !r.availUnavailable && (r.reasons || []).some(x => keysFor.includes(x.key)));
    }

    root.opsStageDomain = {
        STAGES, STAGE_JP, STAGE_SUB, STORAGE_KEY, RAID_DAY_START_HOUR, MAX_ATTACKS,
        jstDate, raidDayKey, detect, parseOverride, serializeOverride, nextOf, prevOf,
        visibleIn, bossReady, checklist, hero, nudgeTargets,
    };
})(typeof window !== 'undefined' ? window : globalThis);
