async function dimExport(MODE, SUBCLASS_NAMES) {
  // --- DIM redux store (same data DIM uses for its item popup)
  let fiber = null;
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (k) { fiber = e[k]; break; } }
  let root = fiber; while (root && root.return) root = root.return;
  let store = null; const q = [root]; let c = 0;
  while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
    if (p && p.store && typeof p.store.getState === 'function') { store = p.store; break; }
    if (x && x.child) q.push(x.child); if (x && x.sibling) q.push(x.sibling); }
  if (!store) throw new Error('DIM store not found - is the inventory loaded?');
  const state = store.getState();
  const stores = state.inventory.stores;
  const hunter = stores.find(s => s.classType === 1);
  if (!hunter) throw new Error('No Hunter character');
  const vault = stores.find(s => s.isVault);

  // --- manifest + clarity from DIM's IndexedDB cache
  const db = await new Promise((res, rej) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => res(r.result); r.onerror = rej; });
  const get = k => new Promise(r => { const t = db.transaction('keyval').objectStore('keyval').get(k); t.onsuccess = () => r(t.result); });
  const ii = await get('d2-manifest-InventoryItem'), sp = await get('d2-manifest-SandboxPerk');
  const col = await get('d2-manifest-Collectible'), clar = (await get('clarity-descriptions')) || {};
  const sets = await get('d2-manifest-EquipableItemSet');

  const ARMOR_STAT = { 2996146975: 0, 392767087: 1, 1943323491: 2, 1735777505: 3, 144602215: 4, 4244567218: 5 };
  const slotOf = it => ({ 'Helmet': 'H', 'Gauntlets': 'A', 'Chest Armor': 'C', 'Leg Armor': 'L', 'Class Armor': 'K', 'Hunter Cloak': 'K' })[it.bucket.name] || ({ 'Helmet': 'H', 'Gauntlets': 'A', 'Chest Armor': 'C', 'Leg Armor': 'L', 'Hunter Cloak': 'K' })[it.typeName];
  const pick = it => (it.bucket.sort === 'Weapons') || (it.bucket.sort === 'Armor' && it.classType === 1);
  const raw = [...hunter.items.map(i => [i, i.equipped ? 'e' : 'i']), ...vault.items.map(i => [i, 'v'])].filter(([i]) => pick(i));

  const known = new Set(JSON.parse(localStorage.getItem('hunterExportKnown') || '[]'));
  const plugs = {}, icons = new Map(), itemIcons = new Map();
  const iconIdx = (map, path) => { if (!path) return -1; if (!map.has(path)) map.set(path, map.size); return map.get(path); };
  const clarityText = h => { const d = clar[h]; if (!d || !d.descriptions || !d.descriptions.en) return '';
    return d.descriptions.en.map(b => (b.linesContent || []).map(l => l.text || '').join('')).join('\n').replace(/\n{3,}/g, '\n\n').trim(); };
  const addPlug = (pd, statsObj) => {
    const h = pd.hash; if (plugs[h]) return h;
    let d = pd.displayProperties.description || '';
    if (!d && pd.perks) d = pd.perks.map(p => sp[p.perkHash]?.displayProperties?.description).filter(Boolean).join('\n');
    if (!d && pd.tooltipNotifications) d = pd.tooltipNotifications.map(t => t.displayString).join('\n');
    const st = [];
    for (const s of (pd.investmentStats || [])) { if (!s.value) continue; const nm = (statDefs[s.statTypeHash] || {}).name; if (nm) st.push([nm, s.value]); }
    plugs[h] = { n: pd.displayProperties.name, t: pd.itemTypeDisplayName || '', d, cl: clarityText(h), ic: iconIdx(icons, pd.displayProperties.icon), st };
    return h;
  };
  const statDefsRaw = await get('d2-manifest-Stat');
  const statDefs = {}; for (const [h, s] of Object.entries(statDefsRaw || {})) statDefs[h] = { name: s.displayProperties?.name };

  // --- wish list (the one DIM has loaded, usually Voltron): grade each weapon roll by perk names
  const wlRolls = state.wishLists?.wishListAndInfo?.wishListRolls || [];
  const wlBy = new Map(); for (const r of wlRolls) { if (!wlBy.has(r.itemHash)) wlBy.set(r.itemHash, []); wlBy.get(r.itemHash).push(r); }
  const pname = h => (ii[h]?.displayProperties?.name || '').replace(/^Enhanced /, '');
  function grade(it) {
    const rolls = [...(wlBy.get(it.hash) || []), ...(wlBy.get(-69420) || [])]; if (!rolls.length) return null;
    const have = new Set(); for (const sk of it.sockets?.allSockets || []) { if (!sk.isPerk) continue; for (const o of (sk.plugOptions || [])) have.add(pname(o.plugDef.hash)); if (sk.plugged) have.add(pname(sk.plugged.plugDef.hash)); }
    const on = new Set(); for (const sk of it.sockets?.allSockets || []) if (sk.isPerk && sk.plugged) on.add(pname(sk.plugged.plugDef.hash));
    let best = null;
    for (const r of rolls) { const need = [...r.recommendedPerks].map(pname).filter(Boolean); if (!need.length || !need.every(n => have.has(n))) continue;
      const g = r.isUndesirable ? -1 : /God/i.test(r.notes || '') ? 2 : 1; const equipped = need.every(n => on.has(n));
      if (!best || g > best[0] || (g === best[0] && equipped && !best[2])) best = [g, (r.notes || '').replace(/\s+/g, ' ').slice(0, 220), equipped ? 1 : 0, /PvP/.test(r.notes || '') && !/PvE/.test(r.notes || '') ? 'pvp' : 'pve']; }
    if (best && best[0] === 2) return best;
    const god = rolls.find(r => !r.isUndesirable && /God/i.test(r.notes || '') && !/PvP/.test(r.notes || '')) || rolls.find(r => !r.isUndesirable && /God/i.test(r.notes || ''));
    const target = god ? [...god.recommendedPerks].map(pname).filter(Boolean) : [];
    return [...(best || [0, '', 0, '']), target];
  }
  const items = [];
  for (const [it, loc] of raw) {
    const isW = it.bucket.sort === 'Weapons';
    const def = ii[it.hash] || {};
    const stats = (it.stats || []).filter(s => s.statHash > 0 && s.displayProperties?.name).map(s =>
      [s.displayProperties.name, s.value, s.base, s.maximumValue || 0, s.bar ? 1 : 0, s.smallerIsBetter ? 1 : 0, s.baseMasterworked ?? null, s.statHash]);
    const cats = [];
    for (const cat of (it.sockets?.categories || [])) {
      const nm = cat.category?.displayProperties?.name || '';
      const socks = [];
      for (const sock of (cat.socketIndexes || []).map(i => it.sockets.allSockets.find(s => s.socketIndex === i)).filter(Boolean)) {
        if (!sock.plugged || !sock.plugged.plugDef) continue;
        const pd = sock.plugged.plugDef;
        if (/Default|Empty/i.test(pd.displayProperties.name) && !sock.isMod) continue;
        if (!pd.displayProperties.name) continue;
        const p = addPlug(pd);
        const opts = (sock.isPerk && sock.plugOptions && sock.plugOptions.length > 1) ? sock.plugOptions.map(o => addPlug(o.plugDef)) : [];
        socks.push(opts.length ? [p, opts] : [p]);
      }
      if (socks.length) cats.push([nm, socks]);
    }
    const setH = def.equippingBlock?.equipableItemSetHash;
    let set = null;
    if (setH && sets[setH]) set = [sets[setH].displayProperties.name, (sets[setH].setPerks || []).map(x => [x.requiredSetCount, sp[x.sandboxPerkHash]?.displayProperties?.name || '', sp[x.sandboxPerkHash]?.displayProperties?.description || ''])];
    items.push({
      id: it.id, h: it.hash, n: it.name, t: it.typeName, r: it.rarity, ex: it.isExotic ? 1 : 0,
      s: isW ? (it.bucket.name || '') : slotOf(it), w: isW ? 1 : 0,
      el: it.element?.displayProperties?.name || '', elIc: iconIdx(icons, it.element?.displayProperties?.icon),
      am: it.ammoType || 0, pw: it.power || 0, tier: it.tier || 0, loc, lk: it.locked ? 1 : 0, cr: it.crafted ? 1 : 0, ad: it.adept ? 1 : 0,
      mw: it.masterwork ? 1 : 0, mwi: it.masterworkInfo?.stats?.[0] ? [it.masterworkInfo.stats[0].name, it.masterworkInfo.stats[0].value, it.masterworkInfo.tier] : null,
      src: it.displaySource || (col[it.collectibleHash]?.sourceString) || '', fl: def.flavorText || '', ss: it.screenshot || def.screenshot || '',
      ic: iconIdx(itemIcons, it.icon), ov: iconIdx(icons, it.iconOverlay),
      st: stats, en: it.energy ? [it.energy.energyUsed, it.energy.energyCapacity] : null, set, sk: cats, wl: isW ? grade(it) : null, tun: isW ? null : (it.sockets?.allSockets || []).find(sk => (sk.plugSet?.plugs || []).some(p => p.plugDef.displayProperties.name === 'Balanced Tuning'))?.socketIndex ?? null, bt: it.breakerType?.displayProperties?.name || ''
    });
  }
  // account-level info for build scoring
  const p = state.inventory.profileResponse || {};
  const exotics = new Set(items.filter(i => i.ex).map(i => i.n));
  const prof = p.profileCollectibles?.data?.collectibles || {}, chc = p.characterCollectibles?.data?.[hunter.id]?.collectibles || {};
  const colState = h => (prof[h] || chc[h] || {}).state;
  for (const [h, cdef] of Object.entries(col)) { const d = ii[cdef.itemHash]; if (!d || d.inventory?.tierType !== 6) continue;
    if (!((d.itemType === 2 && d.classType === 1) || d.itemType === 3)) continue; const s = colState(h); if (s === undefined || (s & 1)) continue; exotics.add(d.displayProperties.name); }
  const aspects = new Set(), subclasses = [];
  const plugSets = [p.profilePlugSets?.data?.plugs || {}, p.characterPlugSets?.data?.[hunter.id]?.plugs || {}];
  for (const src of plugSets) for (const arr of Object.values(src)) for (const pl of arr) { if (!pl.enabled) continue; const d = ii[pl.plugItemHash];
    if (d && /Aspect/.test(d.itemTypeDisplayName || '') && (d.plug?.plugCategoryIdentifier || '').includes('hunter')) aspects.add(d.displayProperties.name); }
  for (const i of hunter.items) if (i.bucket?.sort === 'General' || i.bucket?.name === 'Subclass') { if (i.bucket.name === 'Subclass') subclasses.push(i.name); }

  // subclass sockets and the plugs you have unlocked, for full loadouts (super, abilities, aspects, fragments)
  const subs = hunter.items.filter(i => i.bucket?.name === 'Subclass').map(sc => {
    const cats = {}, opts = {}, cur = {};
    for (const cat of (sc.sockets?.categories || [])) { const nm = cat.category?.displayProperties?.name || ''; cats[nm] = cat.socketIndexes.slice();
      for (const ix of cat.socketIndexes) { const sk = sc.sockets.allSockets.find(z => z.socketIndex === ix); if (!sk) continue;
        opts[ix] = (sk.plugSet?.plugs || sk.plugOptions || []).map(p => [p.plugDef.displayProperties.name, p.plugDef.hash, p.plugDef.plug?.energyCapacity?.capacityValue || 0]);
        if (sk.plugged) cur[ix] = sk.plugged.plugDef.hash; } }
    return { n: sc.name, id: sc.id, h: sc.hash, eq: sc.equipped ? 1 : 0, cats, opts, cur }; });
  const pmItems = hunter.items.filter(i => i.bucket?.sort === 'Postmaster');
  const postmaster = { n: pmItems.length, cap: pmItems[0]?.bucket?.capacity || 21, items: pmItems.map(i => [i.name, i.amount]) };
  const MATS = ['Exotic Engram', 'Exotic Cipher', 'Ascendant Shard', 'Ascendant Alloy', 'Enhancement Core', 'Enhancement Prism', 'Upgrade Module', 'Strange Coin', 'Deepsight Harmonizer', 'Exotic Requisition Order', 'Legendary Mark'];
  const mats = {}; for (const i of [...hunter.items, ...vault.items]) if (MATS.includes(i.name)) mats[i.name] = (mats[i.name] || 0) + (i.amount || 1);
  for (const c of (state.inventory.currencies || [])) { const n = c.displayProperties?.name; if (n) mats[n] = c.quantity; }
  const wsrc = {}; for (const cdef of Object.values(col)) { const d = ii[cdef.itemHash]; if (!d || d.itemType !== 3 || !d.displayProperties?.name || !cdef.sourceString) continue; if (!wsrc[d.displayProperties.name]) wsrc[d.displayProperties.name] = cdef.sourceString.replace(/^Source:\s*/, ''); }
  // seasonal artifact perks, exotic catalysts, crafting patterns, current activity (when in game)
  const cart = p.characterProgressions?.data?.[hunter.id]?.seasonalArtifact;
  const art = cart ? { used: cart.pointsUsed || 0, perks: (cart.tiers || []).flatMap((t, ti) => (t.items || []).filter(x => x.isVisible).map(x => { const d = ii[x.itemHash] || {}; return { n: d.displayProperties?.name || '', d: (d.displayProperties?.description || (d.perks || []).map(pk => sp[pk.perkHash]?.displayProperties?.description).filter(Boolean).join(' ') || '').slice(0, 300), on: x.isActive ? 1 : 0, tier: ti + 1, unl: t.isUnlocked ? 1 : 0 }; })).filter(x => x.n) } : null;
  const allW = [...hunter.items, ...vault.items].filter(i => i.bucket.sort === 'Weapons');
  const catal = []; for (const i of allW) { if (!i.isExotic || !i.catalystInfo || catal.some(c => c.n === i.name)) continue; const o = i.catalystInfo.objectives || [];
    const pct = o.length ? Math.round(100 * o.reduce((t, x) => t + Math.min(1, (x.progress || 0) / (x.completionValue || 1)), 0) / o.length) : 0;
    catal.push({ n: i.name, done: i.catalystInfo.complete ? 1 : 0, unl: i.catalystInfo.unlocked ? 1 : 0, pct }); }
  const pats = []; for (const i of [...stores.flatMap(s => s.items)]) { const r = i.patternUnlockRecord; if (!r || pats.some(x => x.n === i.name)) continue; const o = (r.objectives || [])[0] || {};
    pats.push({ n: i.name, have: o.progress || 0, need: o.completionValue || 0, done: (o.complete || (o.completionValue && o.progress >= o.completionValue)) ? 1 : 0 }); }
  // titles (seals): progress and the closest unfinished triumphs
  let seals = [];
  try {
    const pn = await get('d2-manifest-PresentationNode'), rec = await get('d2-manifest-Record');
    const nodes = p.profilePresentationNodes?.data?.nodes || {}, recs = p.profileRecords?.data?.records || {}, crecs = p.characterRecords?.data?.[hunter.id]?.records || {};
    const root = pn[p.profileRecords?.data?.recordSealsRootNodeHash];
    for (const ch of (root?.children?.presentationNodes || [])) { const d = pn[ch.presentationNodeHash]; const st = nodes[ch.presentationNodeHash]; if (!d || !st || !d.displayProperties?.name) continue;
      if (d.redacted || (st.completionValue || 0) === 0) continue;
      const todo = (d.children?.records || []).map(r => { const rd = rec[r.recordHash]; const rs = recs[r.recordHash] || crecs[r.recordHash]; if (!rd || !rs || (rs.state & 1)) return null;
        const ob = rs.objectives || rs.intervalObjectives || []; const pct = ob.length ? ob.reduce((t, o) => t + Math.min(1, (o.progress || 0) / (o.completionValue || 1)), 0) / ob.length : 0;
        return { n: rd.displayProperties?.name || '', d: (rd.displayProperties?.description || '').slice(0, 140), pct: Math.round(pct * 100) }; }).filter(x => x && x.n && !(x.pct === 0 && /Obsolete|Retired/.test(x.d)));
      seals.push({ n: d.displayProperties.name, title: rec[d.completionRecordHash]?.titleInfo?.titlesByGender?.Male || '', have: st.progressValue || 0, need: st.completionValue || 0, todo: todo.sort((a, b) => b.pct - a.pct).slice(0, 4) }); }
  } catch (e) { seals = []; }
  // armor mods you can socket (name -> [hash, slot, energy]) from the plug sets of your equipped armor
  const modCat = {};
  for (const it of hunter.items.filter(i => i.equipped && i.bucket?.sort === 'Armor')) for (const cat of (it.sockets?.categories || [])) {
    if (!/MODS/i.test(cat.category?.displayProperties?.name || '')) continue;
    for (const ix of cat.socketIndexes) { const sk = it.sockets.allSockets.find(z => z.socketIndex === ix);
      for (const pl of (sk?.plugSet?.plugs || [])) { const pd = pl.plugDef; const pc = pd.plug?.plugCategoryIdentifier || ''; if (!/^enhancements\.v2_/.test(pc)) continue;
        const n = pd.displayProperties?.name; if (n && !modCat[n]) modCat[n] = [pd.hash, pc.replace('enhancements.v2_', ''), pd.plug?.energyCost?.energyCost || 0]; } } }
  const tr = p.profileTransitoryData?.data || null;
  const activity = tr && tr.currentActivity ? { players: tr.currentActivity.numberOfPlayers || (tr.partyMembers || []).length || 1, opp: tr.currentActivity.numberOfOpponents || 0, start: tr.currentActivity.startTime || null, party: (tr.partyMembers || []).length } : null;
  const classes = stores.filter(s => !s.isVault).map(s => ({ cls: s.classType, name: s.className, power: s.powerLevel }));
  const bk = await get('d2-manifest-InventoryBucket');
  const vaultInfo = { n: vault.items.length, cap: (bk && bk[138197802] && bk[138197802].itemCount) || 0 };
  const base = { v: 2, vault: vaultInfo, subs, postmaster, mats, wsrc, art, catal, pats, activity, seals, modCat, updated: new Date().toISOString(), power: hunter.powerLevel || 0, classes, subclasses, aspects: [...aspects].sort(), exotics: [...exotics].sort(), items };
  if (MODE === 'daily') {
    // compact: items already in the published data only send what changes day to day
    const knownItems = new Set(JSON.parse(localStorage.getItem('hunterExportKnownItems') || '[]'));
    const out = items.map(it => knownItems.has(it.id) ? { id: it.id, loc: it.loc, pw: it.pw, lk: it.lk, mw: it.mw, tier: it.tier, k: 1 } : { ...it, ic: -1, ov: -1, elIc: -1 });
    const used = new Set(); out.filter(i => !i.k).forEach(i => i.sk.forEach(c => c[1].forEach(s => { used.add(s[0]); (s[1] || []).forEach(o => used.add(o)); })));
    const newPlugs = {}; for (const h of used) if (!known.has(+h)) newPlugs[h] = { ...plugs[h], ic: -1 };
    return JSON.stringify({ ...base, items: out, plugs: newPlugs, daily: 1 });
  }
  // --- full mode extras: subclass ability icons and sources of missing Hunter exotics
  const kit = {};
  if (SUBCLASS_NAMES) {
    const defs = Object.values(ii).filter(d => d.plug && /hunter|shared|prism/i.test(d.plug.plugCategoryIdentifier || '') && d.displayProperties?.icon);
    for (const key of SUBCLASS_NAMES) { const [t, n] = key.split('|');
      const d = t === 'F' ? defs.find(d => /Fragment/.test(d.itemTypeDisplayName || '') && d.displayProperties.name.endsWith(' of ' + n))
        : defs.find(d => d.displayProperties.name === n && (t !== 'A' || /Aspect/.test(d.itemTypeDisplayName || '')) && !/Fragment/.test(d.itemTypeDisplayName || '') && /hunter/i.test(d.plug.plugCategoryIdentifier))
          || defs.find(d => d.displayProperties.name === n && !/Fragment/.test(d.itemTypeDisplayName || ''))
          || defs.find(d => d.displayProperties.name.endsWith(': ' + n) && /hunter/i.test(d.plug.plugCategoryIdentifier));
      if (d) kit[key] = { n: d.displayProperties.name, t: d.itemTypeDisplayName || '', d: d.displayProperties.description || (d.perks || []).map(p => sp[p.perkHash]?.displayProperties?.description).filter(Boolean).join('\n'), ic: iconIdx(icons, d.displayProperties.icon) }; }
  }
  const missing = [];
  for (const [h, cdef] of Object.entries(col)) { const d = ii[cdef.itemHash]; if (!d || d.inventory?.tierType !== 6 || d.itemType !== 2 || d.classType !== 1) continue;
    const s = colState(h); if (s === undefined || !(s & 1)) continue; if (missing.some(m => m.n === d.displayProperties.name)) continue;
    missing.push({ n: d.displayProperties.name, t: d.itemTypeDisplayName, src: cdef.sourceString || '', ic: iconIdx(itemIcons, d.displayProperties.icon), d: (d.sockets?.socketEntries || []).map(e => ii[e.singleInitialItemHash]).find(p => p && /Intrinsic/.test(p.itemTypeDisplayName || '') && p.displayProperties.description)?.displayProperties.description || '' }); }
  for (const n of ['Still Hunt', 'Speedloader Slacks']) { if (missing.some(m => m.n === n) || exotics.has(n)) continue;
    const e = Object.entries(col).find(([h, c]) => ii[c.itemHash]?.displayProperties?.name === n); if (e) { const d = ii[e[1].itemHash]; missing.push({ n, t: d.itemTypeDisplayName, src: e[1].sourceString || '', ic: iconIdx(itemIcons, d.displayProperties.icon), d: '' }); } }
  async function sprite(map, size, type, q) {
    const list = [...map.keys()]; const cols = 16, rows = Math.max(1, Math.ceil(list.length / cols));
    const cv = document.createElement('canvas'); cv.width = cols * size; cv.height = rows * size;
    const cx = cv.getContext('2d'); cx.imageSmoothingQuality = 'high';
    await Promise.all(list.map(async (path, i) => { try {
      const b = await (await fetch('https://www.bungie.net' + path)).blob(); const bm = await createImageBitmap(b);
      cx.drawImage(bm, (i % cols) * size, Math.floor(i / cols) * size, size, size); } catch (e) {} }));
    return { blob: await new Promise(r => cv.toBlob(r, type, q)), cols, size, n: list.length };
  }
  const si = await sprite(itemIcons, 64, 'image/jpeg', 0.82);
  const sp2 = await sprite(icons, 48, 'image/webp', 0.85);
  const data = { ...base, plugs, kit, missing, sprites: { items: { cols: si.cols, size: si.size, n: si.n }, plugs: { cols: sp2.cols, size: sp2.size, n: sp2.n } } };
  if (MODE === 'app') { // desktop app: hand everything back instead of downloading
    const toUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
    return { data, items: await toUrl(si.blob), plugs: await toUrl(sp2.blob) };
  }
  const dl = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  dl(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'hunter-data.json');
  dl(si.blob, 'hunter-items.jpg'); dl(sp2.blob, 'hunter-plugs.webp');
  localStorage.setItem('hunterExportKnown', JSON.stringify(Object.keys(plugs).map(Number)));
  localStorage.setItem('hunterExportKnownItems', JSON.stringify(items.map(i => i.id)));
  return { items: items.length, plugs: Object.keys(plugs).length, itemIcons: si.n, plugIcons: sp2.n, sizes: [JSON.stringify(data).length, si.blob.size, sp2.blob.size] };
}


async function dimWeekly() {
  let fiber = null;
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (k) { fiber = e[k]; break; } }
  let root = fiber; while (root && root.return) root = root.return;
  let store = null; const q = [root]; let c = 0;
  while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps; if (p && p.store && p.store.getState) { store = p.store; break; } if (x && x.child) q.push(x.child); if (x && x.sibling) q.push(x.sibling); }
  const state = store.getState();
  const db = await new Promise((res, rej) => { const r = indexedDB.open('keyval-store'); r.onsuccess = () => res(r.result); r.onerror = rej; });
  const get = k => new Promise(r => { const t = db.transaction('keyval').objectStore('keyval').get(k); t.onsuccess = () => r(t.result); });
  const ms = await get('d2-manifest-Milestone'), act = await get('d2-manifest-Activity'), mod = await get('d2-manifest-ActivityModifier'), ii = await get('d2-manifest-InventoryItem'), vd = await get('d2-manifest-Vendor');
  const pr = state.inventory.profileResponse; const hunter = state.inventory.stores.find(s => s.classType === 1);
  const cm = (pr.characterProgressions.data[hunter.id] || {}).milestones || {};
  const milestones = Object.values(cm).map(m => { const d = ms[m.milestoneHash] || {};
    const acts = (m.activities || []).map(a => act[a.activityHash]?.displayProperties?.name).filter(Boolean);
    const mods = [...new Set((m.activities || []).flatMap(a => (a.modifierHashes || []).map(h => mod[h]?.displayProperties?.name)).filter(Boolean))];
    const exo = mods.some(n => /Exotic Drop/i.test(n));
    return { n: d.displayProperties?.name || '', d: d.displayProperties?.description || '', end: m.endDate || null, acts, mods: mods.filter(n => !/Exotic Drop|Boosts Gained/i.test(n)).slice(0, 6), exo, rew: !!(m.rewards && m.rewards.length) }; })
    .filter(m => m.n);
  const toUrl = async path => { try { const b = await (await fetch('https://www.bungie.net' + path)).blob(); return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); } catch (e) { return ''; } };
  let xur = null;
  const vch = state.vendors?.vendorsByCharacter?.[hunter.id]?.vendorsResponse;
  if (vch && vch.sales && vch.sales.data) {
    const items = [];
    for (const [vh, s] of Object.entries(vch.sales.data)) { const vn = vd[vh]?.displayProperties?.name || ''; if (!/X[uû]r|Strange Gear/i.test(vn)) continue;
      for (const x of Object.values(s.saleItems)) { const d = ii[x.itemHash]; if (!d || !d.displayProperties?.name) continue;
        const gear = d.itemType === 2 || d.itemType === 3 || /Armor|Helmet|Gauntlets|Cloak|Rifle|Gun|Cannon|Sword|Bow|Launcher|Sidearm|Shotgun|Glaive|Trace/.test(d.itemTypeDisplayName || '');
        if (!gear || /Engram|Ornament|Catalyst/.test(d.itemTypeDisplayName || '') || d.inventory?.tierType < 5) continue; if (d.classType !== 1 && d.classType !== 3) continue;
        if (items.some(i => i.n === d.displayProperties.name)) continue;
        items.push({ n: d.displayProperties.name, t: d.itemTypeDisplayName || '', ex: d.inventory.tierType === 6 ? 1 : 0, ic: await toUrl(d.displayProperties.icon) }); } }
    xur = { items, at: new Date().toISOString() };
  }
  // what the main vendors sell this week (weapons and Hunter armor)
  const vendors = [];
  if (vch && vch.sales && vch.sales.data) {
    const WANT = /^(Banshee-44|Ada-1|Saint-14|Lord Shaxx|Commander Zavala|Eris Morn|Ikora Rey|Petra Venj|Devrim Kay|Failsafe)$/;
    for (const [vh, s] of Object.entries(vch.sales.data)) { const vn = vd[vh]?.displayProperties?.name || ''; if (!WANT.test(vn)) continue;
      const items = [];
      for (const x of Object.values(s.saleItems || {})) { const d = ii[x.itemHash]; if (!d || !d.displayProperties?.name) continue;
        if (!(d.itemType === 3 || (d.itemType === 2 && (d.classType === 1 || d.classType === 3)))) continue; if ((d.inventory?.tierType || 0) < 5) continue;
        if (items.some(i => i.n === d.displayProperties.name)) continue;
        items.push({ n: d.displayProperties.name, t: d.itemTypeDisplayName || '', w: d.itemType === 3 ? 1 : 0, ex: d.inventory.tierType === 6 ? 1 : 0 }); }
      if (items.length) vendors.push({ v: vn, items }); }
  }
  // modifier descriptions for champion and shield detection
  for (const m of milestones) m.modd = [...new Set((Object.values(cm).find(x => (ms[x.milestoneHash]?.displayProperties?.name || '') === m.n)?.activities || []).flatMap(a => (a.modifierHashes || []).map(h => (mod[h]?.displayProperties?.name || '') + ': ' + (mod[h]?.displayProperties?.description || ''))))].join(' | ').slice(0, 1500);
  return { at: new Date().toISOString(), milestones, xur, vendors };
}

// light read used every few minutes: am I in an activity right now?
function dimActivity() {
  let fiber = null;
  for (const e of document.querySelectorAll('*')) { const k = Object.keys(e).find(k => k.startsWith('__reactFiber$')); if (k) { fiber = e[k]; break; } }
  let root = fiber; while (root && root.return) root = root.return;
  const q = [root]; let c = 0;
  while (q.length && c < 20000) { const x = q.shift(); c++; const p = x && x.memoizedProps;
    if (p && p.store && p.store.getState) { const s = p.store.getState(); const tr = s.inventory.profileResponse?.profileTransitoryData?.data;
      if (!tr || !tr.currentActivity) return { in: 0 };
      return { in: 1, players: tr.currentActivity.numberOfPlayers || (tr.partyMembers || []).length || 1, opp: tr.currentActivity.numberOfOpponents || 0, start: tr.currentActivity.startTime || null, party: (tr.partyMembers || []).length }; }
    if (x && x.child) q.push(x.child); if (x && x.sibling) q.push(x.sibling); }
  return null;
}
