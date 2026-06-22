// ==UserScript==
// @name         PikPak Batch JAV Renamer Assistant
// @name:en      PikPak Batch JAV Renamer Assistant
// @name:ja      PikPak Batch JAV Renamer Assistant
// @name:zh-CN   PikPak 批量番号重命名与小文件清理助手
// @name:zh-TW   PikPak 批次番號重新命名與小檔案清理助手
// @name:ko      PikPak Batch JAV Renamer Assistant
// @name:ru      PikPak Batch JAV Renamer Assistant
// @name:es      PikPak Renombrador JAV por lotes
// @name:pt-BR   PikPak Renomeador JAV em lote
// @name:fr      PikPak Renommeur JAV par lots
// @name:de      PikPak JAV-Batch-Umbenennung
// @namespace    https://github.com/CheerChen
// @version      0.1.3
// @description  Batch rename video files and folders with JAV codes in PikPak.
// @description:en Batch rename video files and folders with JAV codes in PikPak.
// @description:ja Batch rename JAV files in PikPak and clean up small files.
// @description:zh-CN 在 PikPak 中批量重命名 JAV 文件，并独立清理小于 100MB 的小文件。
// @description:zh-TW 在 PikPak 中批次重新命名 JAV 檔案，並獨立清理小於 100MB 的小檔案。
// @description:ko Batch rename JAV files in PikPak and clean up small files.
// @description:ru Batch rename JAV files in PikPak and clean up small files.
// @description:es Renombrar archivos JAV por lotes en PikPak y limpiar archivos pequeños.
// @description:pt-BR Renomear arquivos JAV em lote no PikPak e limpar arquivos pequenos.
// @description:fr Renommer les fichiers JAV par lots dans PikPak et nettoyer les petits fichiers.
// @description:de JAV-Dateien in PikPak stapelweise umbenennen und kleine Dateien bereinigen.
// @author       cheerchen37
// @match        *://*mypikpak.com/*
// @match        *://*mypikpak.net/*
// @match        *://*pikpak.me/*
// @require      https://unpkg.com/preact@10/dist/preact.umd.js
// @require      https://unpkg.com/preact@10/hooks/dist/hooks.umd.js
// @require      https://unpkg.com/htm@3/dist/htm.umd.js
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      av-wiki.net
// @connect      api-drive.mypikpak.com
// @icon         https://www.google.com/s2/favicons?domain=mypikpak.com
// @license      MIT
// @homepage     https://github.com/CheerChen/userscripts
// @supportURL   https://github.com/CheerChen/userscripts/issues
// @downloadURL https://update.greasyfork.org/scripts/549418/PikPak%20Batch%20JAV%20Renamer%20Assistant.user.js
// @updateURL https://update.greasyfork.org/scripts/549418/PikPak%20Batch%20JAV%20Renamer%20Assistant.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const { h, render } = preact;
    const { useState, useEffect } = preactHooks;
    const html = htm.bind(h);

    // --- Parser (ported from bangou/parser/parser.go) ---

    const sitePrefixRe = /^([a-zA-Z0-9.-]+)@/;
    const tokenizeRe = /[^a-zA-Z0-9]+/;
    const partTokenRe = /^part(\d+)$/i;
    const tagTokenRe = /^(8k|4k|vr)$/i;
    const heyzoRe = /^(heyzo)(\d{4})(?:\D|$)/i;
    const mgstageRe = /^(\d{3,4}[a-zA-Z]{2,6})(\d{3,6})(?:\D|$)/i;
    const standardRe = /^\d*([a-zA-Z]{2,6})(\d{3,6})(?:\D|$)/i;
    const DEBUG_KEY = 'pikpak-batch-renamer-debug';
    const FLOAT_BUTTON_POS_KEY = 'pikpak-batch-renamer-fab-pos';
    const SMALL_FILE_THRESHOLD_BYTES = 100 * 1024 * 1024;
    const commonDomainTokenRe = /^(com|net|org|me|cn|jp|tv|xyz|club)$/i;

    const DEBUG_ENABLED = (() => {
        try {
            const v = localStorage.getItem(DEBUG_KEY);
            if (v == null) return true; // default on for troubleshooting parser/query mismatches
            return v === '1' || v === 'true';
        } catch {
            return true;
        }
    })();

    function debugLog(label, payload) {
        if (!DEBUG_ENABLED) return;
        if (payload === undefined) console.log(`[PBR] ${label}`);
        else console.log(`[PBR] ${label}`, payload);
    }

    function debugRawHtml(label, url, resp) {
        return;
    }

    function trimLeadingZeros(s) {
        let n = parseInt(s, 10);
        if (isNaN(n)) return s;
        let out = String(n);
        while (out.length < 3) out = '0' + out;
        return out;
    }

    function hasLetter(s) { return /[a-zA-Z]/.test(s); }
    function endsWithLetter(s) { return s.length > 0 && /[a-zA-Z]$/.test(s); }
    function isPureDigits(s) { return s.length > 0 && /^\d+$/.test(s); }

    function extractNumber(raw) {
        const rules = [
            { re: heyzoRe, fmt: m => m[1].toUpperCase() + '-' + m[2] },
            { re: mgstageRe, fmt: m => m[1].toUpperCase() + '-' + trimLeadingZeros(m[2]) },
            { re: standardRe, fmt: m => m[1].toUpperCase() + '-' + trimLeadingZeros(m[2]) },
        ];
        for (const { re, fmt } of rules) {
            const m = raw.match(re);
            if (!m || m.length <= 2) continue;
            // find end of capture group 2 to get rawMatch
            const fullMatch = m[0];
            const rawMatch = raw.substring(0, raw.indexOf(fullMatch) + fullMatch.replace(/\D$/, '').length);
            return { number: fmt(m), rawNumber: rawMatch.toLowerCase() };
        }
        return { number: '', rawNumber: '' };
    }

    function parseNumberParts(number) {
        const m = number.match(/^([0-9]*[A-Z]+)-(\d+)$/);
        if (!m) return null;
        return { series: m[1].replace(/^\d+/, '').toLowerCase(), numRaw: m[2], num: parseInt(m[2], 10) };
    }

    function extractExt(filename) {
        const normalizedName = (filename || '').trim();
        const m = normalizedName.match(/[.。．｡]([a-z0-9]{2,5})$/i);
        if (!m) return { ext: '', base: normalizedName };
        if (partTokenRe.test(m[1])) return { ext: '', base: filename }; // ".part1" is a split marker, not extension
        const ext = '.' + m[1].toLowerCase();
        return { ext, base: normalizedName.substring(0, normalizedName.length - m[1].length - 1) };
    }

    function isLikelyWrappedCode(nameLower, number) {
        const p = parseNumberParts(number);
        if (!p) return false;
        const noPad = String(p.num);
        const re = new RegExp(`[\\(\\[]\\d*${p.series}[-_ ]*0*${noPad}[\\)\\]]`, 'i');
        return re.test(nameLower);
    }

    function scoreCandidate({ raw, number, idx, tokens, nameLower }) {
        const p = parseNumberParts(number);
        if (!p) return -999;

        let score = 0;
        if (p.series.length >= 4) score += 3;
        if (p.num >= 1000) score += 2;
        if (idx > 0) score += 1;
        if (isLikelyWrappedCode(nameLower, number)) score += 4;
        if (nameLower.includes(`@${raw}@`)) score -= 6;
        if (/^\d+[A-Z]+-/.test(number)) score -= 2;

        const next = (tokens[idx + 1] || '').toLowerCase();
        if (commonDomainTokenRe.test(next)) score -= 6;
        if (/^(www|com|net|org|me)$/.test(raw)) score -= 8;
        return score;
    }

    function buildNumberTokens(tokens, idx) {
        const t = (tokens[idx] || '').toLowerCase();
        if (!t || !hasLetter(t)) return [];
        if (partTokenRe.test(t) || tagTokenRe.test(t)) return [];
        const out = [t];
        // e.g. "1155crvr00238" -> additionally try "crvr00238"
        const withoutVendorPrefix = t.match(/^\d{3,4}([a-z]{2,6}\d{3,6})$/i)?.[1];
        if (withoutVendorPrefix) out.push(withoutVendorPrefix.toLowerCase());
        const next = tokens[idx + 1];
        if (next && endsWithLetter(t) && isPureDigits(next) && next.length >= 3) out.push(t + next);
        return out;
    }

    function parse(filename) {
        const { ext, base } = extractExt(filename);
        let name = base;

        const res = { number: '', rawNumber: '', part: 0, tags: [], ext, sourceSite: '' };

        const siteMatch = name.match(sitePrefixRe);
        if (siteMatch) {
            res.sourceSite = siteMatch[1].toLowerCase();
            name = name.replace(sitePrefixRe, '');
        }

        const tokens = name.split(tokenizeRe).filter(Boolean);
        if (tokens.length === 0) return res;

        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            const pm = t.match(partTokenRe);
            if (pm) { if (res.part === 0) res.part = parseInt(pm[1], 10); continue; }
            if (tagTokenRe.test(t)) { res.tags.push(t.toLowerCase()); continue; }
            if (isPureDigits(t) && t.length <= 2 && res.part === 0) { res.part = parseInt(t, 10); continue; }
        }

        res.tags = [...new Set(res.tags)];

        const candidates = [];
        const seen = new Set();
        const nameLower = name.toLowerCase();

        for (let i = 0; i < tokens.length; i++) {
            for (const raw of buildNumberTokens(tokens, i)) {
                const { number, rawNumber } = extractNumber(raw);
                if (!number) continue;
                const key = `${number}|${rawNumber}|${i}`;
                if (seen.has(key)) continue;
                seen.add(key);
                candidates.push({
                    idx: i,
                    raw,
                    number,
                    rawNumber,
                    score: scoreCandidate({ raw, number, idx: i, tokens, nameLower }),
                });
            }
        }

        candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
        if (candidates[0]) {
            res.number = candidates[0].number;
            res.rawNumber = candidates[0].rawNumber;
        }

        debugLog('parse', {
            filename,
            tokens,
            selected: { number: res.number, rawNumber: res.rawNumber, part: res.part, tags: res.tags, ext: res.ext },
            candidates: candidates.map(c => ({ idx: c.idx, raw: c.raw, number: c.number, rawNumber: c.rawNumber, score: c.score })),
        });
        return res;
    }

    const renameKeywordDefinitions = [
        { label: '黑丝', aliases: ['黑丝', '黑絲襪', 'blackstockings'] },
        { label: '丝袜', aliases: ['丝袜', '絲襪'] },
        { label: '白丝', aliases: ['白丝', '白絲襪'] },
        { label: '肉丝', aliases: ['肉丝', '肉絲襪'] },
        { label: '渔网', aliases: ['渔网', '漁網', '網襪'] },
        { label: '过膝袜', aliases: ['过膝袜', '過膝襪', '膝上襪'] },
        { label: '水着', aliases: ['水着', '泳装', '泳裝'] },
        { label: '女仆', aliases: ['女仆', '女僕', 'maid'] },
        { label: 'Cosplay', aliases: ['cosplay'] },
        { label: '眼镜娘', aliases: ['眼镜娘', '眼鏡娘'] },
        { label: '校服', aliases: ['校服', '制服'] },
        { label: '和服', aliases: ['和服', '浴衣'] },
        { label: '运动装', aliases: ['运动装', '運動裝', '体操服', '體操服'] },
        { label: '兽耳', aliases: ['兽耳', '獸耳'] },
        { label: '旗袍', aliases: ['旗袍'] },
        { label: '吊带袜', aliases: ['吊带袜', '吊帶襪'] },
        { label: '婚纱', aliases: ['婚纱', '婚紗'] },
        { label: '兔女郎', aliases: ['兔女郎', 'bunnygirl'] },
        { label: '黑肉', aliases: ['黑肉'] },
        { label: '美腿', aliases: ['美腿'] },
        { label: '白虎', aliases: ['白虎'] },
        { label: '娇小', aliases: ['娇小', '嬌小'] },
        { label: '长身', aliases: ['长身', '長身', '高挑'] },
        { label: '美尻', aliases: ['美尻'] },
        { label: '熟女', aliases: ['熟女'] },
        { label: '软体', aliases: ['软体', '軟體'] },
        { label: '纹身', aliases: ['纹身', '紋身', '刺青'] },
        { label: '巨乳', aliases: ['巨乳'] },
        { label: '贫乳', aliases: ['贫乳', '貧乳'] },
        { label: '短发', aliases: ['短发', '短髮'] },
        { label: '长发', aliases: ['长发', '長髮'] },
        { label: '少女', aliases: ['少女'] },
        { label: '颜射', aliases: ['颜射', '顏射'] },
        { label: '潮吹', aliases: ['潮吹'] },
        { label: '口交', aliases: ['口交', 'フェラ'] },
        { label: '脚交', aliases: ['脚交', '足交'] },
        { label: '深喉', aliases: ['深喉'] },
        { label: '乳交', aliases: ['乳交'] },
        { label: '肛交', aliases: ['肛交'] },
        { label: '接吻', aliases: ['接吻', '舌吻', 'kiss'] },
        { label: '中出', aliases: ['中出'] },
        { label: '痉挛', aliases: ['痉挛', '痙攣'] },
        { label: '高潮', aliases: ['高潮', 'アクメ', '絶頂', '絶頂き', 'イキ'] },
        { label: '口爆', aliases: ['口爆', '口內射精'] },
        { label: '露出', aliases: ['露出'] },
        { label: '缚绑', aliases: ['缚绑', '縛綁', '捆绑', '捆綁', 'bondage'] },
        { label: '男M', aliases: ['男m', 'm男'] },
        { label: '放尿', aliases: ['放尿', '圣水', '聖水'] },
        { label: '凌辱', aliases: ['凌辱', '犯した', '犯され', '犯●れて', 'レイプ'] },
        { label: '集团追奸', aliases: ['集团追奸', '集團追奸', '轮奸', '輪姦'] },
        { label: '瞬间插入', aliases: ['瞬间插入', '瞬間插入'] },
        { label: '泥醉', aliases: ['泥醉'] },
        { label: '按摩', aliases: ['按摩', 'マッサージ'] },
        { label: '一日十回', aliases: ['一日十回'] },
        { label: '逆犯', aliases: ['逆犯'] },
        { label: '痴汉', aliases: ['痴汉', '痴漢'] },
        { label: '泡姬', aliases: ['泡姬', 'soapland'] },
        { label: '多P', aliases: ['多p', '多人'] },
        { label: '3P', aliases: ['3p'] },
        { label: '调教', aliases: ['调教', '調教'] },
        { label: '痴女', aliases: ['痴女'] },
        { label: '母乳', aliases: ['母乳'] },
        { label: '刑具', aliases: ['刑具'] },
        { label: '黑人', aliases: ['黑人'] },
        { label: '童贞', aliases: ['童贞', '童貞'] },
        { label: '巨根', aliases: ['巨根', 'デカチン'] },
        { label: '巨汉', aliases: ['巨汉', '巨漢'] },
        { label: '催眠', aliases: ['催眠'] },
        { label: '丑男', aliases: ['丑男', '醜男'] },
        { label: '时间停止', aliases: ['时间停止', '時間停止'] },
        { label: '媚药', aliases: ['媚药', '媚藥'] },
        { label: '偷拍', aliases: ['偷拍', '盗撮'] },
        { label: '自拍', aliases: ['自拍', 'ハメ撮り', '自撮り'] },
        { label: '性爱', aliases: ['性爱', 'セックス', 'FUCK'] },
        { label: '羞耻', aliases: ['羞耻', '羞恥'] },
        { label: '腰技', aliases: ['腰技', '腰使い'] },
        { label: '诱惑', aliases: ['诱惑', '誘惑'] },
        { label: '复仇', aliases: ['复仇', '復仇'] },
        { label: '女上司', aliases: ['女上司', '上司'] },
        { label: '夫目前犯', aliases: ['夫目前犯'] },
        { label: '下雨天', aliases: ['下雨天', '雨天'] },
        { label: '亲属', aliases: ['亲属', '親屬', '近亲', '近親'] },
        { label: '年龄差', aliases: ['年龄差', '年齡差'] },
        { label: '出轨', aliases: ['出轨', '出軌'] },
        { label: 'NTR', aliases: ['ntr'] },
        { label: '风俗娘', aliases: ['风俗娘', '風俗娘'] },
        { label: '老师', aliases: ['老师', '老師', 'teacher'] },
        { label: '搜查官', aliases: ['搜查官', '捜査官', '搜査官'] },
        { label: '偶像', aliases: ['偶像', 'idol'] },
        { label: '医生', aliases: ['医生', '醫生', 'doctor'] },
        { label: '空姐', aliases: ['空姐', 'ca', 'cabinattendant'] },
        { label: '情侣', aliases: ['情侣', '情侶', 'couple'] },
        { label: '人妻', aliases: ['人妻'] },
        { label: '逃犯', aliases: ['逃犯'] },
        { label: '球队经理', aliases: ['球队经理', '球隊經理', '经理'] },
        { label: '家政妇', aliases: ['家政妇', '家政婦'] },
        { label: '主播', aliases: ['主播'] },
        { label: '护士', aliases: ['护士', '護士', 'nurse'] },
        { label: '未亡人', aliases: ['未亡人'] },
        { label: '家庭教师', aliases: ['家庭教师', '家庭教師'] },
        { label: 'OL', aliases: ['ol'] },
        { label: '魔镜号', aliases: ['魔镜号', '魔鏡號'] },
        { label: '温泉', aliases: ['温泉', '溫泉'] },
        { label: '旅馆', aliases: ['旅馆', '旅館', '旅店'] },
        { label: '办公室', aliases: ['办公室', '辦公室', 'office'] },
        { label: '厕所', aliases: ['厕所', '廁所'] },
        { label: '便利店', aliases: ['便利店', '便利商店'] },
        { label: '电车', aliases: ['电车', '電車'] },
        { label: '洗浴场', aliases: ['洗浴场', '洗浴場', '澡堂'] },
        { label: '浴室', aliases: ['浴室', '風呂', '风吕'] },
        { label: '学校', aliases: ['学校', '學校'] },
        { label: '虚女', aliases: ['虚女', '處女', '处女'] },
        { label: '泳池', aliases: ['泳池', '游池', '游泳池'] },
        { label: '图书馆', aliases: ['图书馆', '圖書館'] },
        { label: '监狱', aliases: ['监狱', '監獄'] },
        { label: '汽车', aliases: ['汽车', '汽車', '车内', '車內'] },
        { label: '健身房', aliases: ['健身房'] },
        { label: '中字', aliases: ['中字', '中文字幕'] },
        { label: '无码', aliases: ['无码', '無碼', 'uncensored'] },
        { label: '破解', aliases: ['破解', '解密'] },
        { label: '流出', aliases: ['流出', 'leak'] },
    ];
    const renameKeywordOrder = new Map(renameKeywordDefinitions.map((def, index) => [def.label, index]));

    function normalizeKeywordToken(text) {
        return (text || '')
            .toString()
            .toLowerCase()
            .replace(/[＃#]/g, '')
            .replace(/[\s_\-()[\]{}]+/g, '');
    }

    function keywordAliasMatchesText(text, alias) {
        const raw = (text || '').toString();
        const aliasRaw = (alias || '').toString();
        if (!raw || !aliasRaw) return false;

        // ASCII aliases must match as standalone tokens to avoid false positives like "OL".
        if (/^[a-z0-9]+$/i.test(aliasRaw)) {
            const loweredAlias = aliasRaw.toLowerCase();
            const loweredText = raw.toLowerCase();
            const tokens = loweredText.split(/[^a-z0-9]+/).filter(Boolean);
            return tokens.includes(loweredAlias);
        }

        return normalizeKeywordToken(raw).includes(normalizeKeywordToken(aliasRaw));
    }

    function extractKeywordsFromText(text) {
        if (!text) return [];
        return renameKeywordDefinitions
            .filter(def => def.aliases.some(alias => keywordAliasMatchesText(text, alias)))
            .map(def => def.label);
    }

    const aggressiveTitleKeywordDefinitions = [
        { label: '老师', aliases: ['教師', '女教師', '先生'] },
        { label: '护士', aliases: ['看護師', 'ナース'] },
        { label: '医生', aliases: ['医師', '女医'] },
        { label: '家政妇', aliases: ['家政婦'] },
        { label: '女上司', aliases: ['女上司', '上司'] },
        { label: '痴汉', aliases: ['痴漢'] },
        { label: '调教', aliases: ['調教'] },
        { label: '诱惑', aliases: ['誘惑'] },
        { label: '复仇', aliases: ['復讐'] },
        { label: '出轨', aliases: ['不倫', '浮気'] },
        { label: 'NTR', aliases: ['寝取られ', '寝取り'] },
        { label: '校服', aliases: ['学生服', 'セーラー服', 'ブレザー', '制服'] },
        { label: '女仆', aliases: ['メイド'] },
        { label: '水着', aliases: ['水着'] },
        { label: '和服', aliases: ['着物'] },
        { label: 'Cosplay', aliases: ['コスプレ'] },
        { label: '兔女郎', aliases: ['バニー'] },
        { label: '黑丝', aliases: ['黒ストッキング', '黒タイツ'] },
        { label: '丝袜', aliases: ['ストッキング'] },
        { label: '过膝袜', aliases: ['ニーハイ'] },
        { label: '巨乳', aliases: ['巨乳', '乳房', '爆乳', '美乳', '発育'] },
        { label: '贫乳', aliases: ['貧乳', '微乳'] },
        { label: '少女', aliases: ['思春期', '女子校生', 'JK', '教え子'] },
        { label: '亲属', aliases: ['義父', '義母', '義兄', '義弟', '義姉', '義妹', '継父', '継母', '叔父', '叔母', '兄嫁', '弟嫁'] },
        { label: '潮吹', aliases: ['潮吹き'] },
        { label: '口交', aliases: ['フェラ'] },
        { label: '脚交', aliases: ['足コキ'] },
        { label: '乳交', aliases: ['パイズリ'] },
        { label: '肛交', aliases: ['アナル'] },
        { label: '接吻', aliases: ['キス'] },
        { label: '中出', aliases: ['中出し'] },
        { label: '露出', aliases: ['露出'] },
        { label: '催眠', aliases: ['催眠'] },
        { label: '媚药', aliases: ['媚薬'] },
        { label: '偷拍', aliases: ['盗撮'] },
    ];

    const titleFallbackKeywordDefinitions = [
        { label: '熟女', aliases: ['お母さん'] },
        { label: '人妻', aliases: ['妻', '人妻', '貞淑妻', 'お母さん', '奥様', '若奥様'] },
        { label: '美尻', aliases: ['痴尻', 'デカ尻', '尻'] },
        { label: '性爱', aliases: ['セックス', 'FUCK'] },
        { label: '凌辱', aliases: ['犯した', '犯され', '犯●れて', 'レイプ'] },
        { label: 'NTR', aliases: ['寝取らせ', '寝取られ', '寝取り'] },
        { label: '肛交', aliases: ['アナル', 'アナルーム'] },
        { label: '自拍', aliases: ['ハメ撮り', '自撮り'] },
        { label: '夫目前犯', aliases: ['夫の目の前'] },
        { label: '痴女', aliases: ['性欲モンスター', '弄ばれて', '小悪魔'] },
        { label: '软体', aliases: ['軟体', '軟体披露', 'バレリーナ'] },
        { label: '上京生活', aliases: ['上京生活', '上京性生活'] },
        { label: '精液检查', aliases: ['精液検査'] },
        { label: '美女', aliases: ['美女', '絶世美女'] },
        { label: '射精', aliases: ['射精', 'ピュッピュ', '暴発'] },
        { label: '无胸罩', aliases: ['ノーブラ'] },
        { label: '乳头', aliases: ['乳首', 'びんびん'] },
        { label: 'OL', aliases: ['女子社員', '社員'] },
        { label: '女上司', aliases: ['マネージャー', '女神マネージャー'] },
        { label: '巨根', aliases: ['デカチン', '巨根'] },
        { label: '羞耻', aliases: ['羞恥'] },
        { label: '腰技', aliases: ['腰使い'] },
        { label: '巨乳', aliases: ['Kカップ', '爆乳'] },
        { label: '高潮', aliases: ['アクメ', '絶頂', 'イキ'] },
        { label: '天然', aliases: ['天然'] },
        { label: '运动', aliases: ['スポーツ'] },
        { label: '露出', aliases: ['全裸'] },
        { label: '痴汉', aliases: ['痴●'] },
        { label: '通勤', aliases: ['通勤'] },
        { label: '高潮', aliases: ['快楽堕ち'] },
    ];

    function mergeKeywordsBySource(...lists) {
        const merged = [];
        const seen = new Set();
        for (const list of lists) {
            for (const keyword of list || []) {
                const key = normalizeKeywordToken(keyword);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(keyword);
            }
        }
        return merged;
    }

    function extractAggressiveKeywordsFromTitle(title) {
        if (!title) return [];
        return aggressiveTitleKeywordDefinitions
            .filter(def => def.aliases.some(alias => keywordAliasMatchesText(title, alias)))
            .map(def => def.label);
    }

    function extractFallbackKeywordsFromTitle(title) {
        if (!title) return [];
        return titleFallbackKeywordDefinitions
            .filter(def => def.aliases.some(alias => keywordAliasMatchesText(title, alias)))
            .map(def => def.label);
    }

    function mergeKeywords(...lists) {
        const merged = [];
        const seen = new Set();
        for (const list of lists) {
            for (const keyword of list || []) {
                const key = normalizeKeywordToken(keyword);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(keyword);
            }
        }
        return merged.sort((a, b) => {
            const ai = renameKeywordOrder.get(a);
            const bi = renameKeywordOrder.get(b);
            if (ai == null && bi == null) return 0;
            if (ai == null) return 1;
            if (bi == null) return -1;
            return ai - bi;
        });
    }

    function extractKeywordsFromDocument(doc) {
        if (!doc) return [];

        const texts = [];
        const selectors = [
            'a[rel~="tag"]',
            '.tags a',
            '.tag a',
            '.tags-links a',
            '.entry-tags a',
            '.entry-meta a',
            '.cat-links a',
            '.entry-categories a',
            '.taxonomy-post_tag a',
            '.taxonomy-product_tag a',
        ];

        for (const selector of selectors) {
            for (const node of doc.querySelectorAll(selector)) {
                const text = node.textContent?.trim();
                if (text) texts.push(text);
            }
        }

        return mergeKeywords(...texts.map(extractKeywordsFromText));
    }

    function collectRenameKeywords(fileName, title, pageKeywords) {
        const page = Array.isArray(pageKeywords) ? pageKeywords : [];
        const titleKeywords = extractKeywordsFromText(title);
        const fileKeywords = extractKeywordsFromText(fileName);
        const aggressiveTitleKeywords = extractAggressiveKeywordsFromTitle(title);
        const mergedKeywords = mergeKeywordsBySource(page, titleKeywords, fileKeywords, aggressiveTitleKeywords);
        const fallbackTitleKeywords = mergedKeywords.length >= 3 ? [] : extractFallbackKeywordsFromTitle(title);
        return mergeKeywordsBySource(mergedKeywords, fallbackTitleKeywords);
    }

    function stripLeadingNumberFromTitle(number, title) {
        const rawTitle = (title || '').trim();
        if (!number || !rawTitle) return rawTitle;
        const parts = parseNumberParts(number);
        if (!parts) return rawTitle;

        const escapedSeries = parts.series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedNoPad = String(parts.num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedRaw = parts.numRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numberPattern = `(?:${escapedSeries}[-_ ]*0*${escapedNoPad}|${escapedSeries}[-_ ]*${escapedRaw})`;
        const leadingPattern = new RegExp(`^[\\s\\[\\(【［「『<]*${numberPattern}[\\s\\]\\)】］」』>.:：-]*`, 'i');

        let cleanTitle = rawTitle;
        for (let i = 0; i < 3; i++) {
            const nextTitle = cleanTitle.replace(leadingPattern, '').trim();
            if (nextTitle === cleanTitle) break;
            cleanTitle = nextTitle;
        }
        return cleanTitle;
    }

    function buildRenamedFileName(number, title, date, keywords, ext, config) {
        const prefixParts = [];
        if (number) prefixParts.push(number);
        const cleanTitle = stripLeadingNumberFromTitle(number, title);
        const limitedKeywords = keywords.slice(0, 3);
        if (limitedKeywords.length > 0) prefixParts.push(limitedKeywords.map(keyword => `[${keyword}]`).join(''));
        const nameParts = [...prefixParts, cleanTitle].filter(Boolean);
        const finalName = nameParts.join(' ');
        return ext ? `${finalName}${ext}` : finalName;
    }

    // ─── PikPak API ───

    function getHeader() {
        let token = '', captcha = '';
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key.startsWith('credentials')) {
                const d = JSON.parse(localStorage.getItem(key));
                token = d.token_type + ' ' + d.access_token;
            }
            if (key.startsWith('captcha')) {
                const d = JSON.parse(localStorage.getItem(key));
                captcha = d.captcha_token;
            }
        }
        let deviceId = localStorage.getItem('deviceid') || '';
        if (deviceId.includes('.')) deviceId = deviceId.split('.')[1]?.substring(0, 32) || deviceId;
        return { Authorization: token, 'x-device-id': deviceId, 'x-captcha-token': captcha };
    }

    function getList(parentId) {
        const url = `https://api-drive.mypikpak.com/drive/v1/files?thumbnail_size=SIZE_MEDIUM&limit=500&parent_id=${parentId}&with_audit=true&filters=${encodeURIComponent('{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}')}`;
        return fetch(url, {
            headers: { 'Content-Type': 'application/json', ...getHeader() },
        }).then(r => r.json());
    }

    function renameFile(fileId, newName) {
        return fetch(`https://api-drive.mypikpak.com/drive/v1/files/${fileId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...getHeader() },
            body: JSON.stringify({ name: newName }),
        }).then(async r => {
            const data = await r.json();
            if (data.error || !r.ok) {
                const err = new Error(data.error_description || t('renameFailed')(data.error));
                err.code = data.error;
                throw err;
            }
            return data;
        });
    }

    function trashFiles(fileIds) {
        if (!Array.isArray(fileIds) || fileIds.length === 0) return Promise.resolve({ tasks: [] });
        return fetch('https://api-drive.mypikpak.com/drive/v1/files:batchTrash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeader() },
            body: JSON.stringify({ ids: fileIds }),
        }).then(async r => {
            const data = await r.json();
            if (data.error || !r.ok) {
                const err = new Error(data.error_description || t('trashFailed')(data.error));
                err.code = data.error;
                throw err;
            }
            return data;
        });
    }

    function moveFilesToParent(fileIds, parentId) {
        if (!Array.isArray(fileIds) || fileIds.length === 0) return Promise.resolve({ tasks: [] });
        return fetch('https://api-drive.mypikpak.com/drive/v1/files:batchMove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeader() },
            body: JSON.stringify({ ids: fileIds, to: { parent_id: parentId } }),
        }).then(async r => {
            const data = await r.json();
            if (data.error || !r.ok) {
                const err = new Error(data.error_description || t('moveFailed')(data.error));
                err.code = data.error;
                throw err;
            }
            return data;
        });
    }

    // ─── AV-wiki Query ───

    function httpRequest(opts) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: opts.method || 'GET',
                url: opts.url,
                headers: opts.headers || {},
                onload: r => resolve({ status: r.status, responseText: r.responseText }),
                onerror: e => reject(new Error(e.statusText || 'Network error')),
                ontimeout: () => reject(new Error('Request timeout')),
            });
        });
    }

    function parseDetailPage(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let name = doc.querySelector('.blockquote-like p')?.textContent || null;
        if (!name) {
            const entry = doc.querySelector('.entry-title');
            if (entry) {
                const clone = entry.cloneNode(true);
                clone.querySelectorAll('.entry-subtitle, span').forEach(n => n.remove());
                name = clone.textContent || null;
            }
        }
        const date =
            doc.querySelector('time.date.published')?.getAttribute('datetime') ||
            doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content')?.slice(0, 10) ||
            null;
        const keywords = extractKeywordsFromDocument(doc);
        if (name) name = name.trim();
        if (name) name = name.replace(/[\/:*?"<>|\x00-\x1F]/g, '_');
        return { title: name, date, keywords };
    }

    function buildDirectUrl(keyword) { return `https://av-wiki.net/${keyword.toLowerCase()}/`; }
    function buildSearchUrl(term) { return `https://av-wiki.net/?s=${encodeURIComponent(term)}&post_type=product`; }

    function buildDirectUrlCandidates(parsed) {
        const urls = [];
        const seen = new Set();
        const add = slug => {
            if (!slug) return;
            const url = `https://av-wiki.net/${slug.toLowerCase()}/`;
            if (seen.has(url)) return;
            seen.add(url);
            urls.push(url);
        };

        const fromNumber = parsed.number.toLowerCase();
        add(fromNumber);

        const raw = (parsed.rawNumber || '').toLowerCase();
        const rawMatch = raw.match(/^(\d*[a-z]{2,10})(\d{1,6})$/);
        if (rawMatch) {
            const series = rawMatch[1];
            const num = String(parseInt(rawMatch[2], 10));
            add(`${series}-${num}`);
            add(`${series}-${rawMatch[2]}`);
        }

        return urls;
    }

    function buildSearchTerms(parsed) {
        const terms = [];
        const seen = new Set();
        const add = term => {
            if (!term) return;
            if (seen.has(term)) return;
            seen.add(term);
            terms.push(term);
        };

        add(parsed.number);
        add(parsed.number?.toLowerCase());
        add(parsed.rawNumber);

        const raw = (parsed.rawNumber || '').toLowerCase();
        const rawMatch = raw.match(/^(\d*[a-z]{2,10})(\d{1,6})$/);
        if (rawMatch) {
            const series = rawMatch[1];
            const num = String(parseInt(rawMatch[2], 10));
            add(`${series}-${num}`);
            add(`${series}-${rawMatch[2]}`);
        }

        return terms;
    }

    function extractSlug(url) {
        try {
            const path = new URL(url).pathname;
            return path.split('/').filter(Boolean)[0] || '';
        } catch {
            return '';
        }
    }

    function numberMentionVariants(number) {
        const p = parseNumberParts(number);
        if (!p) return [];
        const noPad = String(p.num);
        const pad3 = noPad.padStart(3, '0');
        return [...new Set([`${p.series}${noPad}`, `${p.series}${pad3}`, `${p.series}${p.numRaw}`])];
    }

    function containsExpectedNumber(text, number) {
        const norm = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        return numberMentionVariants(number).some(v => norm.includes(v));
    }

    function isSameNumberBySlug(slug, number) {
        const p = parseNumberParts(number);
        if (!p) return false;
        const m = slug.toLowerCase().match(/^(\d*[a-z]{2,6})[-_]?0*(\d{1,6})(?:$|[-_])/);
        if (!m) return false;
        const series = m[1].replace(/^\d+/, '');
        const num = parseInt(m[2], 10);
        return series === p.series && num === p.num;
    }

    function extractSearchResultLinks(doc) {
        const selectors = [
            '.read-more a[href^="https://av-wiki.net/"]',
            '.archive-list .read-more a[href^="https://av-wiki.net/"]',
            '.archive-list a[href^="https://av-wiki.net/"][title]',
            '.column-flex .archive-list a[href^="https://av-wiki.net/"][title]',
        ];

        const links = [];
        const seen = new Set();
        for (const selector of selectors) {
            for (const a of doc.querySelectorAll(selector)) {
                const href = a.href;
                if (!href) continue;
                if (!/^https:\/\/av-wiki\.net\/[^/?#]+\/?$/i.test(href)) continue;
                if (seen.has(href)) continue;
                seen.add(href);
                links.push(href);
            }
        }
        return links;
    }

    async function queryAVwiki(parsed) {
        if (!parsed.number) throw new Error('No number');

        const directUrls = buildDirectUrlCandidates(parsed);
        debugLog('direct-candidates', { number: parsed.number, rawNumber: parsed.rawNumber, directUrls });
        for (const directUrl of directUrls) {
            const directResp = await httpRequest({ url: directUrl });
            debugRawHtml('direct', directUrl, directResp);
            if (directResp.status !== 200) continue;

            const { title, date, keywords } = parseDetailPage(directResp.responseText);
            debugLog('direct-parse', { number: parsed.number, directUrl, title, date, keywords });
            if (title && containsExpectedNumber(title, parsed.number)) return { title, date, keywords };
        }

        // Fallback: search
        const searchTerms = buildSearchTerms(parsed);
        debugLog('search-terms', { number: parsed.number, rawNumber: parsed.rawNumber, searchTerms });
        for (const searchTerm of searchTerms) {
            const searchUrl = buildSearchUrl(searchTerm);
            const searchResp = await httpRequest({ url: searchUrl });
            debugRawHtml('search', searchUrl, searchResp);
            const doc = new DOMParser().parseFromString(searchResp.responseText, 'text/html');

            const links = extractSearchResultLinks(doc);
            debugLog('search-candidates', { number: parsed.number, searchTerm, links });

            for (const link of links) {
                const slug = extractSlug(link);
                const matchedBySlug = isSameNumberBySlug(slug, parsed.number);
                debugLog('search-link-check', { link, slug, number: parsed.number, searchTerm, matchedBySlug });
                if (!matchedBySlug) continue;

                const detailResp = await httpRequest({ url: link });
                debugRawHtml('search-detail', link, detailResp);
                if (detailResp.status === 200) {
                    const { title, date, keywords } = parseDetailPage(detailResp.responseText);
                    debugLog('search-detail-parse', { link, title, date, keywords });
                    if (title && containsExpectedNumber(title, parsed.number)) return { title, date, keywords };
                }
            }
        }
        throw new Error('Not found');
    }

    // ─── Config ───

    const CONFIG_KEY = 'pikpak-batch-renamer-config';
    const defaultConfig = { fixFileExtension: true, sortBy: 'name', sortDir: 'asc' };
    const getConfig = () => { try { return { ...defaultConfig, ...JSON.parse(localStorage.getItem(CONFIG_KEY)) }; } catch { return { ...defaultConfig }; } };
    const setConfig = c => localStorage.setItem(CONFIG_KEY, JSON.stringify(c));

    // ─── i18n ───

    const i18n = {
        zh: {
            batchRename: '批量重命名',
            batchRenameFiles: '批量重命名文件',
            confirmRename: '确认重命名',
            renameComplete: '重命名完成',
            selectAll: '全选',
            name: '名称',
            createdTime: '创建时间',
            modifiedTime: '修改时间',
            size: '大小',
            asc: '升序',
            desc: '降序',
            selectFiles: '请选择文件',
            scanning: '扫描中...',
            scanCodes: '扫描番号',
            config: '配置选项',
            fixExt: '修复文件扩展名',
            fixExtDesc: '当文件缺少扩展名时，根据文件名信息自动补充',
            aboutToRename: n => `即将重命名 ${n} 个文件，请确认后继续。`,
            original: '原名',
            newName: '新名',
            progress: (cur, total) => `重命名进度: ${cur}/${total}`,
            cancel: '取消',
            next: '下一步',
            back: '上一步',
            confirming: '确认重命名',
            renaming: '重命名中...',
            resultSummary: (s, f, t) => `重命名完成！成功: ${s}, 失败: ${f}, 总计: ${t}`,
            failedFiles: '失败的文件:',
            renameFailed: code => `重命名失败 (${code})`,
        },
        en: {
            batchRename: 'Batch Rename',
            batchRenameFiles: 'Batch Rename Files',
            confirmRename: 'Confirm Rename',
            renameComplete: 'Rename Complete',
            selectAll: 'Select All',
            name: 'Name',
            createdTime: 'Created',
            modifiedTime: 'Modified',
            size: 'Size',
            asc: 'Asc',
            desc: 'Desc',
            selectFiles: 'Select files',
            scanning: 'Scanning...',
            scanCodes: 'Scan Codes',
            config: 'Settings',
            fixExt: 'Fix file extension',
            fixExtDesc: 'Auto-add extension when missing based on file info',
            aboutToRename: n => `About to rename ${n} file(s). Please confirm.`,
            original: 'From',
            newName: 'To',
            progress: (cur, total) => `Renaming: ${cur}/${total}`,
            cancel: 'Cancel',
            next: 'Next',
            back: 'Back',
            confirming: 'Confirm Rename',
            renaming: 'Renaming...',
            resultSummary: (s, f, t) => `Done! Success: ${s}, Failed: ${f}, Total: ${t}`,
            failedFiles: 'Failed files:',
            renameFailed: code => `Rename failed (${code})`,
        },
    };

    Object.assign(i18n.zh, {
        confirmRename: '确认重命名',
        renameComplete: '重命名完成',
        confirmCleanup: '确认清理小文件',
        cleanupComplete: '清理完成',
        cleanupSmallFiles: '清理小文件',
        smallFileRule: size => '“清理小文件”会单独筛出小于 ' + size + ' 的普通文件，并在确认后移入回收站。',
        aboutToTrash: count => '即将删除 ' + count + ' 个小文件，请确认后继续。',
        renameSection: '待重命名文件',
        trashSection: '待删除文件',
        trashPending: '将移入回收站',
        progress: (cur, total) => '处理进度: ' + cur + '/' + total,
        confirming: '确认执行',
        renaming: '处理中...',
        renameResultSummary: rename => '重命名完成。成功 ' + rename.success + '，失败 ' + rename.failed + '，总计 ' + rename.total + '。',
        cleanupResultSummary: trash => '清理完成。成功 ' + trash.success + '，失败 ' + trash.failed + '，总计 ' + trash.total + '。',
        noRenameTargets: '当前选中的项目里没有扫描到可重命名的番号文件。',
        noSmallFiles: '当前选中的文件或文件夹里没有小于 100MB 的普通文件。',
        trashFailed: code => '删除失败 (' + code + ')',
    });
    Object.assign(i18n.en, {
        confirmRename: 'Confirm Rename',
        renameComplete: 'Rename Complete',
        confirmCleanup: 'Confirm Small File Cleanup',
        cleanupComplete: 'Cleanup Complete',
        cleanupSmallFiles: 'Clean Small Files',
        smallFileRule: size => '"Clean Small Files" separately finds regular files smaller than ' + size + ' and trashes them only after confirmation.',
        aboutToTrash: count => 'About to trash ' + count + ' small file(s). Please confirm.',
        renameSection: 'Files To Rename',
        trashSection: 'Files To Trash',
        trashPending: 'Will move to trash',
        progress: (cur, total) => 'Processing: ' + cur + '/' + total,
        confirming: 'Confirm Execute',
        renaming: 'Processing...',
        renameResultSummary: rename => 'Rename finished. Success: ' + rename.success + ', Failed: ' + rename.failed + ', Total: ' + rename.total + '.',
        cleanupResultSummary: trash => 'Cleanup finished. Success: ' + trash.success + ', Failed: ' + trash.failed + ', Total: ' + trash.total + '.',
        noRenameTargets: 'No renameable code-matched files were found in the current selection.',
        noSmallFiles: 'No regular files smaller than 100MB were found in the current selection.',
        trashFailed: code => 'Trash failed (' + code + ')',
    });
    Object.assign(i18n.zh, {
        flattenSubfolders: '拆分子文件夹',
        confirmFlatten: '确认拆分子文件夹',
        flattenComplete: '拆分完成',
        aboutToFlatten: (moveCount, folderCount, conflictCount) => '即将移动 ' + moveCount + ' 个文件，删除 ' + folderCount + ' 个空子文件夹，跳过 ' + conflictCount + ' 个冲突文件。',
        flattenMoveSection: '将移动到母文件夹的文件',
        flattenDeleteSection: '将删除的空子文件夹',
        flattenConflictSection: '将跳过的冲突文件',
        noFlattenTargets: '当前选中的文件夹里没有可拆分的子文件夹内容。',
        flattenResultSummary: flatten => '拆分完成。移动成功 ' + flatten.moveSuccess + '，移动失败 ' + flatten.moveFailed + '，删除空文件夹成功 ' + flatten.folderDeleteSuccess + '，删除空文件夹失败 ' + flatten.folderDeleteFailed + '，跳过冲突 ' + flatten.conflictSkipped + '。',
        moveFailed: code => '移动失败 (' + code + ')',
        deleteFolderFailed: code => '删除空文件夹失败 (' + code + ')',
    });
    Object.assign(i18n.en, {
        flattenSubfolders: 'Flatten Subfolders',
        confirmFlatten: 'Confirm Flatten Subfolders',
        flattenComplete: 'Flatten Complete',
        aboutToFlatten: (moveCount, folderCount, conflictCount) => 'About to move ' + moveCount + ' file(s), delete ' + folderCount + ' empty child folder(s), and skip ' + conflictCount + ' conflicting file(s).',
        flattenMoveSection: 'Files To Move To Parent',
        flattenDeleteSection: 'Empty Child Folders To Delete',
        flattenConflictSection: 'Conflicting Files To Skip',
        noFlattenTargets: 'No flattenable child-folder content was found in the current selection.',
        flattenResultSummary: flatten => 'Flatten finished. Moved: ' + flatten.moveSuccess + ' succeeded, ' + flatten.moveFailed + ' failed. Empty child folders deleted: ' + flatten.folderDeleteSuccess + ' succeeded, ' + flatten.folderDeleteFailed + ' failed. Skipped conflicts: ' + flatten.conflictSkipped + '.',
        moveFailed: code => 'Move failed (' + code + ')',
        deleteFolderFailed: code => 'Empty-folder delete failed (' + code + ')',
    });

    const lang = (navigator.language || '').startsWith('zh') ? 'zh' : 'en';
    const t = key => i18n[lang][key];

    // ─── Styles ───

    const colors = { primary: '#303133', secondary: '#606266', success: '#67c23a', danger: '#f56c6c', warning: '#e6a23c', blue: '#409eff' };

    // ─── Components ───

    const delay = ms => new Promise(r => setTimeout(r, ms));

    async function trashFolderWhenEmpty(folderId, options = {}) {
        const {
            maxAttempts = 3,
            retryDelayMs = 800,
            listFolder = getList,
            trashFolder = trashFiles,
            wait = delay,
        } = options;

        let remaining = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const resp = await listFolder(folderId);
            remaining = Array.isArray(resp?.files) ? resp.files : [];
            if (remaining.length === 0) {
                await trashFolder([folderId]);
                return { deleted: true, attempts: attempt, remainingCount: 0 };
            }
            if (attempt < maxAttempts) await wait(retryDelayMs);
        }

        return { deleted: false, attempts: maxAttempts, remainingCount: remaining.length };
    }

    function getFileSize(file) {
        return parseInt(file?.size || '0', 10) || 0;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function isSmallFileCandidate(file) {
        const size = getFileSize(file);
        return file?.kind !== 'drive#folder' && size > 0 && size < SMALL_FILE_THRESHOLD_BYTES;
    }

    function ConfigPanel({ config, onChange }) {
        const toggle = key => { const c = { ...config, [key]: !config[key] }; setConfig(c); onChange(c); };
        return html`
            <div style="padding:12px;background:#f8f9fa;border-radius:6px;margin-bottom:16px;border-top:1px solid #ebeef5">
                <label style="display:flex;align-items:center;cursor:pointer;padding:4px 0">
                    <input type="checkbox" checked=${config.fixFileExtension} onChange=${() => toggle('fixFileExtension')} style="margin-right:8px" />
                    <span style="font-size:14px">${t('fixExt')}</span>
                </label>
                <div style="font-size:12px;color:${colors.secondary};margin-left:24px">
                    ${t('fixExtDesc')}
                </div>
                <div style="font-size:12px;color:${colors.warning};margin-top:10px">
                    ${t('smallFileRule')(formatBytes(SMALL_FILE_THRESHOLD_BYTES))}
                </div>
            </div>`;
    }

    function FileItem({ file, selected, onSelect, status, newName, sortBy }) {
        const icons = { valid: '✅', invalid: '❌', loading: '⏳', delete: '🗑️' };
        const formatInfo = f => {
            if (sortBy === 'size') return getFileSize(f) > 0 ? formatBytes(getFileSize(f)) : '';
            if (sortBy === 'created_time' || sortBy === 'modified_time') return f[sortBy] ? new Date(f[sortBy]).toLocaleString() : '';
            return '';
        };
        return html`
            <div style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #f0f0f0;opacity:${status === 'invalid' ? 0.5 : 1}">
                <input type="checkbox" checked=${selected} onChange=${e => onSelect(file.id, e.target.checked)}
                    disabled=${status === 'invalid'} style="margin-right:10px" />
                <span style="margin-right:8px">${file.kind === 'drive#folder' ? '📁' : '📄'}</span>
                <div style="flex:1;min-width:0">
                    <div style="font-weight:500;word-break:break-word">${file.name}</div>
                    ${newName && html`<div style="font-size:12px;color:${colors.success};margin-top:2px;word-break:break-word">→ ${newName}</div>`}
                    ${status === 'delete' && html`<div style="font-size:12px;color:${colors.danger};margin-top:2px;word-break:break-word">${t('trashPending')}</div>`}
                </div>
                <span style="margin-left:16px;font-size:12px;color:${colors.secondary};white-space:nowrap">${formatInfo(file)}</span>
                <span style="margin-left:16px;font-size:16px">${icons[status] || ''}</span>
            </div>`;
    }

    function BatchRenameModal({ onClose }) {
        const [files, setFiles] = useState([]);
        const [selected, setSelected] = useState(new Set());
        const [statuses, setStatuses] = useState({});
        const [newNames, setNewNames] = useState({});
        const [validating, setValidating] = useState(false);
        const [renaming, setRenaming] = useState(false);
        const [progress, setProgress] = useState({ cur: 0, total: 0 });
        const [confirm, setConfirm] = useState(false);
        const [results, setResults] = useState(null);
        const [mode, setMode] = useState('rename');
        const [cleanupTargets, setCleanupTargets] = useState([]);
        const [flattenPlan, setFlattenPlan] = useState([]);
        const [config, setConfigState] = useState(getConfig());
        const [showConfig, setShowConfig] = useState(false);
        const [sortBy, setSortBy_] = useState(config.sortBy || 'name');
        const [sortDir, setSortDir_] = useState(config.sortDir || 'asc');
        const setSortBy = v => { setSortBy_(v); const c = { ...config, sortBy: v }; setConfig(c); setConfigState(c); };
        const setSortDir = v => { setSortDir_(v); const c = { ...config, sortDir: v }; setConfig(c); setConfigState(c); };

        const sortFiles = (list, by, dir) => {
            return [...list].sort((a, b) => {
                const af = a.kind === 'drive#folder';
                const bf = b.kind === 'drive#folder';
                if (af !== bf) return af ? -1 : 1;
                let av = a[by];
                let bv = b[by];
                if (by === 'size') {
                    av = parseInt(av || '0', 10);
                    bv = parseInt(bv || '0', 10);
                } else if (by.includes('time')) {
                    av = new Date(av).getTime();
                    bv = new Date(bv).getTime();
                } else {
                    av = (av || '').toLowerCase();
                    bv = (bv || '').toLowerCase();
                }
                const cmp = av > bv ? 1 : av < bv ? -1 : 0;
                return dir === 'asc' ? cmp : -cmp;
            });
        };

        useEffect(() => {
            let pid = location.pathname.split('/').pop();
            if (pid === 'all') pid = '';
            getList(pid).then(r => r.files && setFiles(sortFiles(r.files, sortBy, sortDir))).catch(console.error);
        }, []);

        useEffect(() => { setFiles(f => sortFiles(f, sortBy, sortDir)); }, [sortBy, sortDir]);

        const toggleSelect = (id, on) => setSelected(s => {
            const next = new Set(s);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
        const selectAll = on => setSelected(on ? new Set(files.map(f => f.id)) : new Set());
        const renameList = files.filter(f => selected.has(f.id) && statuses[f.id] === 'valid');
        const trashList = cleanupTargets;
        const flattenSummary = flattenPlan.reduce((acc, group) => {
            acc.moveCount += group.moves.length;
            acc.folderCount += group.deleteFolders.length;
            acc.conflictCount += group.conflicts.length;
            return acc;
        }, { moveCount: 0, folderCount: 0, conflictCount: 0 });

        const validateFiles = async () => {
            if (selected.size === 0) return alert(t('selectFiles'));
            setMode('rename');
            setConfirm(false);
            setResults(null);
            setCleanupTargets([]);
            setFlattenPlan([]);
            setValidating(true);
            const sts = {};
            const names = {};
            const list = files.filter(f => selected.has(f.id));

            for (let i = 0; i < list.length; i += 3) {
                const batch = list.slice(i, i + 3);
                await Promise.all(batch.map(async file => {
                    const isFile = file.kind !== 'drive#folder';
                    const parsed = parse(file.name);
                    if (!parsed.number) {
                        debugLog('validate-invalid-no-number', { file: file.name, parsed });
                        sts[file.id] = 'invalid';
                        return;
                    }

                    sts[file.id] = 'loading';
                    setStatuses(p => ({ ...p, ...sts }));

                    try {
                        const info = await queryAVwiki(parsed);
                        debugLog('validate-hit', { file: file.name, parsed, info });
                        sts[file.id] = 'valid';
                        let ext = parsed.ext;
                        if (!ext && isFile && config.fixFileExtension && file.mime_type) {
                            const m = file.mime_type.match(/\/([a-z0-9]+)/);
                            if (m) ext = '.' + m[1];
                        }
                        const pageKeywords = Array.isArray(info.keywords) ? info.keywords : [];
                        const finalKeywords = collectRenameKeywords(file.name, info.title, pageKeywords);
                        names[file.id] = buildRenamedFileName(parsed.number, info.title, info.date, finalKeywords, ext, config);
                    } catch (e) {
                        debugLog('validate-miss', { file: file.name, parsed, error: e?.message || String(e) });
                        sts[file.id] = 'invalid';
                    }
                }));
                setStatuses(p => ({ ...p, ...sts }));
                setNewNames(p => ({ ...p, ...names }));
                if (i + 3 < list.length) await delay(2000);
            }
            setValidating(false);
            if (!Object.values(sts).some(status => status === 'valid')) {
                alert(t('noRenameTargets'));
                return;
            }
            setConfirm(true);
        };

        const collectSmallFiles = async (entries, seen = new Set()) => {
            const found = [];
            for (const entry of entries) {
                if (!entry || seen.has(entry.id)) continue;
                seen.add(entry.id);
                if (entry.kind === 'drive#folder') {
                    try {
                        const resp = await getList(entry.id);
                        const children = Array.isArray(resp?.files) ? resp.files : [];
                        const nested = await collectSmallFiles(children, seen);
                        found.push(...nested);
                    } catch (e) {
                        debugLog('cleanup-folder-scan-failed', { folder: entry.name, id: entry.id, error: e?.message || String(e) });
                    }
                    continue;
                }
                if (isSmallFileCandidate(entry)) found.push(entry);
            }
            return found;
        };

        const collectFlattenPlan = async parents => {
            const groups = [];

            const scanNestedFolders = async (folder, parentGroup, reservedNames, lineage) => {
                const resp = await getList(folder.id);
                const entries = Array.isArray(resp?.files) ? resp.files : [];
                const childFolders = entries.filter(entry => entry.kind === 'drive#folder');
                const directFiles = entries.filter(entry => entry.kind !== 'drive#folder');
                const pathParts = [...lineage, folder.name];
                const pathLabel = pathParts.join(' / ');

                for (const file of directFiles) {
                    if (reservedNames.has(file.name)) {
                        parentGroup.conflicts.push({ file, fromFolder: folder, pathLabel });
                        continue;
                    }
                    reservedNames.add(file.name);
                    parentGroup.moves.push({ file, fromFolder: folder, parent: parentGroup.parent, pathLabel });
                }

                for (const child of childFolders) {
                    await scanNestedFolders(child, parentGroup, reservedNames, pathParts);
                }

                parentGroup.deleteFolders.push({ folder, depth: pathParts.length, pathLabel });
            };

            for (const parent of parents) {
                if (!parent || parent.kind !== 'drive#folder') continue;
                try {
                    const resp = await getList(parent.id);
                    const children = Array.isArray(resp?.files) ? resp.files : [];
                    const childFolders = children.filter(entry => entry.kind === 'drive#folder');
                    const reservedNames = new Set(children.filter(entry => entry.kind !== 'drive#folder').map(entry => entry.name));
                    const group = { parent, moves: [], deleteFolders: [], conflicts: [] };

                    for (const childFolder of childFolders) {
                        await scanNestedFolders(childFolder, group, reservedNames, []);
                    }

                    group.deleteFolders.sort((a, b) => b.depth - a.depth || a.folder.name.localeCompare(b.folder.name));

                    if (group.moves.length > 0 || group.deleteFolders.length > 0 || group.conflicts.length > 0) {
                        groups.push(group);
                    }
                } catch (e) {
                    debugLog('flatten-parent-scan-failed', { parent: parent.name, id: parent.id, error: e?.message || String(e) });
                }
            }
            return groups;
        };

        const prepareCleanup = async () => {
            if (selected.size === 0) return alert(t('selectFiles'));
            setValidating(true);
            setConfirm(false);
            setResults(null);
            setMode('cleanup');
            setFlattenPlan([]);
            const chosen = files.filter(f => selected.has(f.id));
            const found = await collectSmallFiles(chosen);
            const nextStatuses = { ...statuses };
            files.forEach(file => {
                if (nextStatuses[file.id] === 'delete') delete nextStatuses[file.id];
            });
            found.forEach(file => {
                if (files.some(root => root.id === file.id)) nextStatuses[file.id] = 'delete';
            });
            setStatuses(nextStatuses);
            setCleanupTargets(found);
            setValidating(false);
            if (found.length === 0) {
                alert(t('noSmallFiles'));
                return;
            }
            setConfirm(true);
        };

        const prepareFlatten = async () => {
            if (selected.size === 0) return alert(t('selectFiles'));
            setValidating(true);
            setConfirm(false);
            setResults(null);
            setMode('flatten');
            setCleanupTargets([]);
            const parents = files.filter(f => selected.has(f.id) && f.kind === 'drive#folder');
            const plan = await collectFlattenPlan(parents);
            setFlattenPlan(plan);
            setValidating(false);
            const summary = plan.reduce((acc, group) => {
                acc.moveCount += group.moves.length;
                acc.folderCount += group.deleteFolders.length;
                return acc;
            }, { moveCount: 0, folderCount: 0 });
            if (summary.moveCount === 0 && summary.folderCount === 0) {
                alert(t('noFlattenTargets'));
                return;
            }
            setConfirm(true);
        };

        const performAction = async () => {
            setRenaming(true);
            const failedFiles = [];

            if (mode === 'cleanup') {
                let trashSuccess = 0;
                let trashFailed = 0;
                const trashTargets = cleanupTargets;
                const totalOps = trashTargets.length;
                setProgress({ cur: 0, total: totalOps });

                for (let i = 0; i < trashTargets.length; i += 20) {
                    const batch = trashTargets.slice(i, i + 20);
                    try {
                        await trashFiles(batch.map(f => f.id));
                        trashSuccess += batch.length;
                    } catch (e) {
                        trashFailed += batch.length;
                        batch.forEach(file => failedFiles.push({ name: file.name, error: e.message, action: 'trash' }));
                    }
                    setProgress({ cur: trashSuccess + trashFailed, total: totalOps });
                    if (i + 20 < trashTargets.length) await delay(1000);
                }

                setResults({
                    mode: 'cleanup',
                    rename: { success: 0, failed: 0, total: 0 },
                    trash: { success: trashSuccess, failed: trashFailed, total: trashTargets.length },
                    flatten: null,
                    failedFiles,
                });
                setRenaming(false);
                return;
            }

            if (mode === 'flatten') {
                let moveSuccess = 0;
                let moveFailed = 0;
                let folderDeleteSuccess = 0;
                let folderDeleteFailed = 0;
                const conflictSkipped = flattenSummary.conflictCount;
                const totalOps = flattenSummary.moveCount + flattenSummary.folderCount;
                setProgress({ cur: 0, total: totalOps });

                for (const group of flattenPlan) {
                    for (let i = 0; i < group.moves.length; i += 20) {
                        const batch = group.moves.slice(i, i + 20);
                        try {
                            await moveFilesToParent(batch.map(item => item.file.id), group.parent.id);
                            moveSuccess += batch.length;
                        } catch (e) {
                            moveFailed += batch.length;
                            batch.forEach(item => failedFiles.push({ name: item.file.name, error: e.message, action: 'move' }));
                        }
                        setProgress({ cur: moveSuccess + moveFailed + folderDeleteSuccess + folderDeleteFailed, total: totalOps });
                        if (i + 20 < group.moves.length) await delay(1000);
                    }

                    for (const folder of group.deleteFolders) {
                        try {
                            const deleteResult = await trashFolderWhenEmpty(folder.folder.id);
                            if (deleteResult.deleted) {
                                folderDeleteSuccess++;
                            } else {
                                folderDeleteFailed++;
                                failedFiles.push({ name: folder.pathLabel, error: t('deleteFolderFailed')('not-empty'), action: 'delete-folder' });
                            }
                        } catch (e) {
                            folderDeleteFailed++;
                            failedFiles.push({ name: folder.pathLabel, error: e.message, action: 'delete-folder' });
                        }
                        setProgress({ cur: moveSuccess + moveFailed + folderDeleteSuccess + folderDeleteFailed, total: totalOps });
                    }
                }

                setResults({
                    mode: 'flatten',
                    rename: { success: 0, failed: 0, total: 0 },
                    trash: { success: 0, failed: 0, total: 0 },
                    flatten: { moveSuccess, moveFailed, folderDeleteSuccess, folderDeleteFailed, conflictSkipped },
                    failedFiles,
                });
                setRenaming(false);
                return;
            }

            const renameTargets = files.filter(f => selected.has(f.id) && statuses[f.id] === 'valid');
            let renameSuccess = 0;
            let renameFailed = 0;
            const totalOps = renameTargets.length;
            setProgress({ cur: 0, total: totalOps });

            for (let i = 0; i < renameTargets.length; i += 5) {
                const batch = renameTargets.slice(i, i + 5);
                await Promise.all(batch.map(async file => {
                    const nn = newNames[file.id];
                    if (file.name === nn) {
                        renameSuccess++;
                    } else {
                        try {
                            await renameFile(file.id, nn);
                            renameSuccess++;
                        } catch (e) {
                            renameFailed++;
                            failedFiles.push({ name: file.name, error: e.message, action: 'rename' });
                        }
                    }
                    setProgress({ cur: renameSuccess + renameFailed, total: totalOps });
                }));
                if (i + 5 < renameTargets.length) await delay(1000);
            }

            setResults({
                mode: 'rename',
                rename: { success: renameSuccess, failed: renameFailed, total: renameTargets.length },
                trash: { success: 0, failed: 0, total: 0 },
                flatten: null,
                failedFiles,
            });
            setRenaming(false);
        };

        const reset = () => {
            onClose();
            if ((results?.rename?.success || 0) > 0 || (results?.trash?.success || 0) > 0 || (results?.flatten?.moveSuccess || 0) > 0 || (results?.flatten?.folderDeleteSuccess || 0) > 0) {
                setTimeout(() => location.reload(), 300);
            }
        };

        return html`
            <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000"
                 onClick=${e => e.target === e.currentTarget && reset()}>
                <div style="background:#fff;border-radius:8px;padding:24px;box-shadow:0 10px 25px rgba(0,0,0,.2);width:90%;max-width:860px;max-height:80vh;display:flex;flex-direction:column"
                     onClick=${e => e.stopPropagation()}>

                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;border-bottom:1px solid #ebeef5;padding-bottom:16px">
                        <h2 style="margin:0;font-size:18px">${results ? (results.mode === 'cleanup' ? t('cleanupComplete') : results.mode === 'flatten' ? t('flattenComplete') : t('renameComplete')) : confirm ? (mode === 'cleanup' ? t('confirmCleanup') : mode === 'flatten' ? t('confirmFlatten') : t('confirmRename')) : t('batchRenameFiles')}</h2>
                        <button onClick=${reset} style="background:none;border:none;font-size:24px;cursor:pointer;color:${colors.secondary}">×</button>
                    </div>

                    <div style="flex:1;overflow-y:auto">
                        ${results && html`
                            <div style="padding:20px;background:#f0f9ff;border-radius:6px;margin-bottom:20px">
                                <div style="font-size:16px;font-weight:500;margin-bottom:10px">
                                    ${results.mode === 'cleanup'
                ? t('cleanupResultSummary')(results.trash)
                : results.mode === 'flatten'
                    ? t('flattenResultSummary')(results.flatten)
                    : t('renameResultSummary')(results.rename)}
                                </div>
                                ${results.failedFiles.length > 0 && html`
                                    <div style="font-size:14px;color:${colors.danger}">
                                        <div>${t('failedFiles')}</div>
                                        ${results.failedFiles.map(f => html`<div key=${f.name + f.action}>${f.name} (${f.action}): ${f.error}</div>`)}
                                    </div>`}
                            </div>`}

                        ${confirm && !results && mode === 'rename' && html`
                            <div>
                                <div style="padding:16px;background:#fff7e6;border-radius:6px;margin-bottom:16px;border:1px solid #ffd666">
                                    ${t('aboutToRename')(renameList.length)}
                                </div>
                                <div style="max-height:400px;overflow-y:auto">
                                    ${renameList.map(f => html`
                                        <div key=${f.id} style="padding:8px;border-bottom:1px solid #f0f0f0;font-size:14px">
                                            <div style="color:#909399">${t('original')}: ${f.name}</div>
                                            <div style="color:${colors.success}">${t('newName')}: ${newNames[f.id]}</div>
                                        </div>`)}
                                </div>
                            </div>`}

                        ${confirm && !results && mode === 'cleanup' && html`
                            <div>
                                <div style="padding:16px;background:#fff7e6;border-radius:6px;margin-bottom:16px;border:1px solid #ffd666">
                                    ${t('aboutToTrash')(trashList.length)}
                                </div>
                                <div style="font-weight:600;margin-bottom:8px">${t('trashSection')}</div>
                                <div style="max-height:320px;overflow-y:auto">
                                    ${trashList.map(f => html`
                                        <div key=${f.id} style="padding:8px;border-bottom:1px solid #f0f0f0;font-size:14px">
                                            <div style="color:#909399">${t('original')}: ${f.name}</div>
                                            <div style="color:${colors.danger}">${t('trashPending')} (${formatBytes(getFileSize(f))})</div>
                                        </div>`)}
                                </div>
                            </div>`}

                        ${confirm && !results && mode === 'flatten' && html`
                            <div>
                                <div style="padding:16px;background:#fff7e6;border-radius:6px;margin-bottom:16px;border:1px solid #ffd666">
                                    ${t('aboutToFlatten')(flattenSummary.moveCount, flattenSummary.folderCount, flattenSummary.conflictCount)}
                                </div>
                                <div style="display:flex;flex-direction:column;gap:16px">
                                    ${flattenPlan.map(group => html`
                                        <div key=${group.parent.id} style="padding:12px;border:1px solid #ebeef5;border-radius:8px">
                                            <div style="font-size:15px;font-weight:600;margin-bottom:10px">${group.parent.name}</div>
                                            ${group.moves.length > 0 && html`
                                                <div style="font-size:13px;font-weight:600;margin-bottom:6px">${t('flattenMoveSection')}</div>
                                                ${group.moves.map(item => html`<div key=${item.file.id} style="padding:6px 0;border-bottom:1px solid #f5f7fa;font-size:13px;color:${colors.secondary}">${item.pathLabel} -> ${item.file.name}</div>`)}
                                            `}
                                            ${group.deleteFolders.length > 0 && html`
                                                <div style="font-size:13px;font-weight:600;margin:10px 0 6px">${t('flattenDeleteSection')}</div>
                                                ${group.deleteFolders.map(item => html`<div key=${item.folder.id} style="padding:6px 0;border-bottom:1px solid #f5f7fa;font-size:13px;color:${colors.danger}">${item.pathLabel}</div>`)}
                                            `}
                                            ${group.conflicts.length > 0 && html`
                                                <div style="font-size:13px;font-weight:600;margin:10px 0 6px">${t('flattenConflictSection')}</div>
                                                ${group.conflicts.map(item => html`<div key=${item.file.id} style="padding:6px 0;border-bottom:1px solid #f5f7fa;font-size:13px;color:${colors.warning}">${item.pathLabel} -> ${item.file.name}</div>`)}
                                            `}
                                        </div>`)}
                                </div>
                            </div>`}

                        ${!confirm && !results && html`
                            <div>
                                <div style="padding:12px;background:#f8f9fa;border-radius:6px;margin-bottom:16px">
                                    <div style="display:flex;justify-content:space-between;align-items:center">
                                        <label style="display:flex;align-items:center">
                                            <input type="checkbox" onChange=${e => selectAll(e.target.checked)} style="margin-right:8px" />
                                            ${t('selectAll')}
                                        </label>
                                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end">
                                            <select value=${sortBy} onChange=${e => setSortBy(e.target.value)}
                                                style="padding:4px;border-radius:4px;border:1px solid #dcdfe6">
                                                <option value="name">${t('name')}</option>
                                                <option value="created_time">${t('createdTime')}</option>
                                                <option value="modified_time">${t('modifiedTime')}</option>
                                                <option value="size">${t('size')}</option>
                                            </select>
                                            <select value=${sortDir} onChange=${e => setSortDir(e.target.value)}
                                                style="padding:4px;border-radius:4px;border:1px solid #dcdfe6">
                                                <option value="asc">${t('asc')}</option>
                                                <option value="desc">${t('desc')}</option>
                                            </select>
                                            <button onClick=${validateFiles} disabled=${validating || selected.size === 0}
                                                style="padding:8px 16px;border:none;border-radius:4px;cursor:pointer;background:${validating || selected.size === 0 ? '#c0c4cc' : colors.blue};color:#fff">
                                                ${validating ? t('scanning') : selected.size === 0 ? t('selectFiles') : t('scanCodes')}
                                            </button>
                                            <button onClick=${prepareCleanup} disabled=${selected.size === 0 || validating}
                                                style="padding:8px 16px;border:none;border-radius:4px;cursor:pointer;background:${selected.size === 0 || validating ? '#c0c4cc' : colors.danger};color:#fff">
                                                ${t('cleanupSmallFiles')}
                                            </button>
                                            <button onClick=${prepareFlatten} disabled=${selected.size === 0 || validating}
                                                style="padding:8px 16px;border:none;border-radius:4px;cursor:pointer;background:${selected.size === 0 || validating ? '#c0c4cc' : colors.warning};color:#fff">
                                                ${t('flattenSubfolders')}
                                            </button>
                                            <button onClick=${() => setShowConfig(!showConfig)}
                                                style="padding:8px 12px;background:${showConfig ? '#e9ecef' : 'transparent'};border:1px solid #dcdfe6;border-radius:4px;cursor:pointer;font-size:13px">${t('config')}</button>
                                        </div>
                                    </div>
                                    ${showConfig && html`<${ConfigPanel} config=${config} onChange=${c => setConfigState(c)} />`}
                                </div>
                                <div style="max-height:400px;overflow-y:auto">
                                    ${files.map(f => html`<${FileItem} key=${f.id} file=${f} selected=${selected.has(f.id)}
                                        onSelect=${toggleSelect} status=${statuses[f.id]} newName=${newNames[f.id]} sortBy=${sortBy} />`)}
                                </div>
                            </div>`}
                    </div>

                    <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:20px;padding-top:16px;border-top:1px solid #ebeef5">
                        ${renaming && html`<div style="flex:1;color:${colors.secondary}">${t('progress')(progress.cur, progress.total)}</div>`}
                        ${!results && !confirm && html`<button onClick=${reset} style="padding:8px 16px;border:1px solid #dcdfe6;border-radius:4px;cursor:pointer;background:#fff">${t('cancel')}</button>`}
                        ${!results && confirm && [
                html`<button onClick=${() => setConfirm(false)} disabled=${renaming}
                                style="padding:8px 16px;border:1px solid #dcdfe6;border-radius:4px;cursor:pointer;background:#fff">${t('back')}</button>`,
                html`<button onClick=${performAction} disabled=${renaming}
                                style="padding:8px 16px;border:none;border-radius:4px;cursor:pointer;background:${renaming ? '#c0c4cc' : colors.blue};color:#fff">${renaming ? t('renaming') : t('confirming')}</button>`
            ]}
                    </div>
                </div>
            </div>`;
    }


    // Init

    function openBatchRenameModal() {
        if (document.getElementById('pikpak-batch-renamer-modal')) return;
        const container = document.createElement('div');
        container.id = 'pikpak-batch-renamer-modal';
        document.body.appendChild(container);
        render(html`<${BatchRenameModal} onClose=${() => { render(null, container); container.remove(); }} />`, container);
    }

    function isFabVisible() {
        return location.pathname !== '/';
    }

    function loadFabPosition() {
        try {
            const saved = JSON.parse(localStorage.getItem(FLOAT_BUTTON_POS_KEY) || 'null');
            if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return null;
            return saved;
        } catch {
            return null;
        }
    }

    function saveFabPosition(pos) {
        try {
            localStorage.setItem(FLOAT_BUTTON_POS_KEY, JSON.stringify(pos));
        } catch { }
    }

    function clampFabPosition(left, top, width, height) {
        const pad = 12;
        const maxLeft = Math.max(pad, window.innerWidth - width - pad);
        const maxTop = Math.max(pad, window.innerHeight - height - pad);
        return {
            left: Math.min(Math.max(pad, left), maxLeft),
            top: Math.min(Math.max(pad, top), maxTop),
        };
    }

    function applyFabPosition(button, pos) {
        const rect = button.getBoundingClientRect();
        const next = clampFabPosition(pos.left, pos.top, rect.width, rect.height);
        button.style.left = `${next.left}px`;
        button.style.top = `${next.top}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        return next;
    }

    function mountFloatingButton() {
        if (document.getElementById('pikpak-batch-renamer-fab')) return;

        const button = document.createElement('div');
        button.id = 'pikpak-batch-renamer-fab';
        button.className = 'menu-box';
        button.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:24px',
            'z-index:9999',
            'display:flex',
            'justify-content:flex-end',
            'align-items:center',
            'cursor:grab',
            'user-select:none',
            '-webkit-user-select:none',
            'touch-action:none',
        ].join(';');
        button.innerHTML = `
            <div class="control-button" style="
                display:flex;
                align-items:center;
                justify-content:center;
                width:64px;
                height:64px;
                border-radius:20px;
                background:#306eff;
                border:1px solid rgba(48,110,255,.28);
                box-shadow:0 12px 30px rgba(48,110,255,.28);
                transition:transform var(--transition,0.2s cubic-bezier(0.645, 0.045, 0.355, 1)), box-shadow var(--transition,0.2s cubic-bezier(0.645, 0.045, 0.355, 1)), background var(--transition,0.2s cubic-bezier(0.645, 0.045, 0.355, 1));
            ">
                <div class="transfer-entry" aria-label="${t('batchRename')}" title="${t('batchRename')}" style="
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    width:28px;
                    height:28px;
                    color:#fff;
                ">
                    <svg fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:24px;height:24px">
                        <path stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                    </svg>
                </div>
            </div>`;
        const controlButton = button.querySelector('.control-button');
        if (controlButton) {
            controlButton.addEventListener('mouseenter', () => {
                controlButton.style.transform = 'translateY(-1px)';
                controlButton.style.boxShadow = '0 16px 34px rgba(48,110,255,.34)';
                controlButton.style.background = '#4a80ff';
            });
            controlButton.addEventListener('mouseleave', () => {
                controlButton.style.transform = 'translateY(0)';
                controlButton.style.boxShadow = '0 12px 30px rgba(48,110,255,.28)';
                controlButton.style.background = '#306eff';
            });
        }

        let pointerId = null;
        let startX = 0;
        let startY = 0;
        let originLeft = 0;
        let originTop = 0;
        let dragging = false;

        const onPointerMove = e => {
            if (e.pointerId !== pointerId) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (!dragging && Math.hypot(dx, dy) >= 6) {
                dragging = true;
                button.style.cursor = 'grabbing';
            }
            if (!dragging) return;
            const next = applyFabPosition(button, { left: originLeft + dx, top: originTop + dy });
            saveFabPosition(next);
        };

        const finishPointer = e => {
            if (e.pointerId !== pointerId) return;
            if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
            button.style.cursor = 'grab';
            const wasDragging = dragging;
            pointerId = null;
            dragging = false;
            if (!wasDragging) openBatchRenameModal();
        };

        button.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            const rect = button.getBoundingClientRect();
            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            originLeft = rect.left;
            originTop = rect.top;
            dragging = false;
            button.setPointerCapture(pointerId);
            e.preventDefault();
        });
        button.addEventListener('pointermove', onPointerMove);
        button.addEventListener('pointerup', finishPointer);
        button.addEventListener('pointercancel', finishPointer);
        button.addEventListener('lostpointercapture', e => {
            if (e.pointerId !== pointerId) return;
            pointerId = null;
            dragging = false;
            button.style.cursor = 'grab';
        });

        document.body.appendChild(button);
        const savedPos = loadFabPosition();
        if (savedPos) {
            const next = applyFabPosition(button, savedPos);
            saveFabPosition(next);
        }
        button.style.display = isFabVisible() ? 'flex' : 'none';

        const syncVisibility = () => {
            button.style.display = isFabVisible() ? 'flex' : 'none';
            if (button.style.display !== 'none') {
                const rect = button.getBoundingClientRect();
                const next = clampFabPosition(rect.left, rect.top, rect.width, rect.height);
                button.style.left = `${next.left}px`;
                button.style.top = `${next.top}px`;
                button.style.right = 'auto';
                button.style.bottom = 'auto';
                saveFabPosition(next);
            }
        };

        window.addEventListener('resize', syncVisibility);
        window.addEventListener('popstate', syncVisibility);

        const { pushState, replaceState } = history;
        history.pushState = function (...args) {
            const out = pushState.apply(this, args);
            syncVisibility();
            return out;
        };
        history.replaceState = function (...args) {
            const out = replaceState.apply(this, args);
            syncVisibility();
            return out;
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFloatingButton);
    else setTimeout(mountFloatingButton, 1000);

})();
