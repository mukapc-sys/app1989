// ============================================================================
// comissao-faixa.js
// Motor de comissão POR FAIXA (progressiva), usado em vários lugares.
//
// SERVIÇOS — a faixa depende do total de SERVIÇO do barbeiro no período (mês),
//   e a % vale para TUDO (não é marginal):
//     0 a 7.999      -> 40%
//     8.000 a 10.999 -> 45%
//     11.000+        -> 50%
//
// PRODUTOS — a faixa depende da QUANTIDADE de unidades vendidas no período,
//   e a % cai sobre o VALOR dos produtos:
//     0 a 9 un   -> 10%
//     10 a 19 un -> 20%
//     20+ un     -> 30%
//
// Fonte de dados: itens_comanda de comandas FINALIZADAS no período.
// ============================================================================

const { supabaseAdmin } = require('../config/supabase')

function pctServico(total) { return total < 8000 ? 40 : (total < 11000 ? 45 : 50) }
function pctProduto(unid)  { return unid  < 10   ? 10 : (unid  < 20    ? 20 : 30) }
function round(n) { return Math.round((Number(n) || 0) * 100) / 100 }

// Busca paginada: o Supabase devolve no máximo 1000 linhas por vez.
// Sem isto, períodos com +1000 atendimentos somam só uma parte (faturamento
// e comissão saem truncados). buildQuery() deve montar a query do zero a cada página.
// PERFORMANCE (#10): a 1ª página traz o TOTAL de linhas (count) e as demais páginas
// são buscadas EM PARALELO (antes eram uma atrás da outra).
async function fetchAll(buildQuery) {
  const pageSize = 1000
  // buildQuery(true) -> mesma query pedindo o TOTAL de linhas (só na 1ª página)
  const first = await buildQuery(true).range(0, pageSize - 1)
  if (first.error) throw first.error
  let all = first.data || []
  if (all.length < pageSize) return all
  const total = (typeof first.count === 'number') ? first.count : null
  if (total == null) {
    // sem total: modo sequencial (seguro)
    let from = pageSize
    while (from <= 200000) {
      const { data, error } = await buildQuery(false).range(from, from + pageSize - 1)
      if (error) throw error
      if (!data || !data.length) break
      all = all.concat(data)
      if (data.length < pageSize) break
      from += pageSize
    }
    return all
  }
  const paginas = []
  for (let from = pageSize; from < Math.min(total, 200000); from += pageSize) {
    paginas.push(buildQuery(false).range(from, from + pageSize - 1))
  }
  const res = await Promise.all(paginas)
  for (const r of res) { if (r.error) throw r.error; all = all.concat(r.data || []) }
  return all
}
const _CNT = (c) => (c ? { count: 'exact' } : undefined)

// CACHE CURTO (#10): caixa, dashboard, resumo, comissão e metas chamam este mesmo
// cálculo várias vezes na mesma abertura de tela. Guarda o resultado por 60s e
// junta chamadas simultâneas iguais numa só (não repete a varredura).
const _cache = new Map()
const CACHE_MS = 60 * 1000
function _chave({ ini, fim, unidade_id }) {
  // "fim" costuma ser "agora" (muda a cada ms) — arredonda para o minuto
  return [ini, Math.floor(Date.parse(fim) / 60000), unidade_id || '*'].join('|')
}

/**
 * Calcula a comissão por faixa de cada barbeiro num intervalo.
 * @param {object} opts { ini, fim }  ISO strings;  fim é EXCLUSIVO
 * @param {string|null} opts.unidade_id  filtra por unidade (null = todas)
 * @returns {Promise<{linhas:Array, total_comissao:number, total_servico:number, total_produto:number}>}
 */
async function _calcularComissaoFaixa({ ini, fim, unidade_id = null }) {
  // (#10) as leituras abaixo são independentes -> disparam TODAS juntas (paralelo)
  // e só depois são somadas. Antes eram 5 idas ao banco em fila.
  const pItens = fetchAll((c) => {
    let q = supabaseAdmin
      .from('itens_comanda')
      .select('tipo, produto_id, quantidade, valor_unit, colaborador_id, comandas!inner(colaborador_id, unidade_id, status, finalizada_em)', _CNT(c))
      .eq('comandas.status', 'finalizada')
      .gte('comandas.finalizada_em', ini)
      .lt('comandas.finalizada_em', fim)
    if (unidade_id) q = q.eq('comandas.unidade_id', unidade_id)
    return q
  })

  // Produtos de categorias que NÃO pagam comissão (ex.: Bar): contam só no
  // faturamento da unidade, nunca na comissão do barbeiro.
  const pBar = (async () => {
    const { data: barCats } = await supabaseAdmin
      .from('categorias_produto').select('id').eq('paga_comissao', false)
    const catIds = (barCats || []).map(c => c.id)
    if (!catIds.length) return new Set()
    const { data: bp } = await supabaseAdmin
      .from('produtos').select('id').in('categoria_id', catIds)
    return new Set((bp || []).map(p => p.id))
  })()

  // AppBarber realizado FORA do sistema (não virou comanda): conta como SERVIÇO.
  // is('agendamento_id', null) garante que não duplica com comandas/agendamentos finalizados.
  const pAbs = fetchAll((c) => {
    let qab = supabaseAdmin
      .from('agenda_appbarber')
      .select('valor, colaborador_id', _CNT(c))
      .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
      .gte('inicio', ini).lt('inicio', fim)
    if (unidade_id) qab = qab.eq('unidade_id', unidade_id)
    return qab
  })

  // Produtos IMPORTADOS do AppBarber (tabela espelho agenda_appbarber_produtos).
  // Antes NÃO entravam na comissão. Decisão do cliente:
  //  - contam só a partir de jun/2026 (não mexe no que o AppBarber já pagou no passado);
  //  - entram como produto normal e são recalculados pela FAIXA ATUAL do sistema;
  //  - Bar (comissao = 0) não entra.
  const PROD_IMPORT_DESDE = new Date('2026-06-01T00:00:00-03:00')   // ⬅️ data de corte (ajuste aqui se precisar)
  const _loProd = (new Date(ini) > PROD_IMPORT_DESDE ? new Date(ini) : PROD_IMPORT_DESDE).toISOString()
  const pProdsImp = (new Date(_loProd) < new Date(fim))
    ? fetchAll((c) => {
        let qp = supabaseAdmin
          .from('agenda_appbarber_produtos')
          .select('quantidade, valor_unit, colaborador_id', _CNT(c))
          .gt('comissao', 0)                       // só barbearia (Bar = 0, não paga)
          .gte('data', _loProd).lt('data', fim)
        if (unidade_id) qp = qp.eq('unidade_id', unidade_id)
        return qp
      })
    : Promise.resolve([])

  const [itens, barProdIds, abs, prodsImp] = await Promise.all([pItens, pBar, pAbs, pProdsImp])

  // Agrega por barbeiro
  const acc = {}
  const novo = () => ({ servico_total: 0, produto_total: 0, produto_unid: 0, plano_total: 0, servico_qtd: 0 })
  for (const it of (itens || [])) {
    // barbeiro do ITEM (ex.: produto de barbearia vendido por outro barbeiro);
    // se o item não tiver, cai no barbeiro da comanda (comportamento antigo).
    const cid = it.colaborador_id || (it.comandas && it.comandas.colaborador_id)
    if (!cid) continue
    if (it.produto_id && barProdIds.has(it.produto_id)) continue // Bar: não paga comissão
    if (!acc[cid]) acc[cid] = novo()
    const qtd = parseInt(it.quantidade) || 1
    const valor = (parseFloat(it.valor_unit) || 0) * qtd
    const tipo = String(it.tipo || '').toLowerCase()
    if (tipo.indexOf('produto') !== -1) {
      acc[cid].produto_total += valor
      acc[cid].produto_unid += qtd
    } else {
      // serviço, corte E plano entram aqui (plano segue a MESMA regra de serviço)
      acc[cid].servico_total += valor
      if (tipo.indexOf('plano') !== -1) acc[cid].plano_total += valor // medição separada
      else acc[cid].servico_qtd += qtd // atendimentos (plano não conta)
    }
  }
  for (const a of (abs || [])) {
    const cid = a.colaborador_id
    if (!cid) continue
    if (!acc[cid]) acc[cid] = novo()
    acc[cid].servico_total += parseFloat(a.valor || 0)
    acc[cid].servico_qtd += 1
  }
  for (const it of (prodsImp || [])) {
    const cid = it.colaborador_id
    if (!cid) continue
    if (!acc[cid]) acc[cid] = novo()
    const qtd = parseInt(it.quantidade) || 1
    acc[cid].produto_total += (parseFloat(it.valor_unit) || 0) * qtd
    acc[cid].produto_unid  += qtd
  }

  // Nomes dos barbeiros
  const ids = Object.keys(acc)
  const nomes = {}, unidadeNome = {}
  if (ids.length) {
    const { data: cols } = await supabaseAdmin.from('colaboradores').select('id, nome, unidades(nome)').in('id', ids)
    ;(cols || []).forEach(c => { nomes[c.id] = c.nome; unidadeNome[c.id] = (c.unidades && c.unidades.nome) || '' })
  }

  const linhas = ids.map(cid => {
    const a = acc[cid]
    const sPct = pctServico(a.servico_total)
    const pPct = pctProduto(a.produto_unid)
    const sCom = a.servico_total * sPct / 100
    const pCom = a.produto_total * pPct / 100
    return {
      colaborador_id: cid,
      nome: nomes[cid] || '—',
      unidade: unidadeNome[cid] || '',
      atendimentos: a.servico_qtd || 0,
      servico_total: round(a.servico_total),
      servico_pct: sPct,
      servico_comissao: round(sCom),
      produto_total: round(a.produto_total),
      produto_unidades: a.produto_unid,
      produto_pct: pPct,
      produto_comissao: round(pCom),
      plano_total: round(a.plano_total),
      comissao_total: round(sCom + pCom)
    }
  }).sort((x, y) => y.comissao_total - x.comissao_total)

  return {
    linhas,
    total_comissao: round(linhas.reduce((s, l) => s + l.comissao_total, 0)),
    total_servico: round(linhas.reduce((s, l) => s + l.servico_total, 0)),
    total_produto: round(linhas.reduce((s, l) => s + l.produto_total, 0))
  }
}

// Versão com cache curto + junção de chamadas simultâneas (ver _cache acima).
async function calcularComissaoFaixa(opts) {
  const o = { ini: opts.ini, fim: opts.fim, unidade_id: opts.unidade_id || null }
  const k = _chave(o)
  const hit = _cache.get(k)
  if (hit && (Date.now() - hit.t) < CACHE_MS) return hit.p
  const p = _calcularComissaoFaixa(o)
  _cache.set(k, { t: Date.now(), p })
  p.catch(() => _cache.delete(k))   // erro não fica em cache
  if (_cache.size > 200) { for (const kk of _cache.keys()) { _cache.delete(kk); if (_cache.size <= 100) break } }
  return p
}

// Limites ISO do mês de uma data (default: hoje). Retorna { ini, fim } com fim exclusivo.
function limitesMes(ref) {
  const d = ref ? new Date(ref) : new Date()
  const y = d.getFullYear(), m = d.getMonth() // 0-11
  const ini = new Date(Date.UTC(y, m, 1)).toISOString()
  const fimMes = new Date(Date.UTC(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, 1))
  // Não conta o FUTURO: o fim é o menor entre "fim do mês" e "agora".
  // (mês passado -> fim do mês; mês atual -> agora). Mantém admin e barbeiro iguais.
  const agora = new Date()
  const fim = (agora < fimMes ? agora : fimMes).toISOString()
  return { ini, fim }
}

module.exports = { calcularComissaoFaixa, pctServico, pctProduto, limitesMes }
