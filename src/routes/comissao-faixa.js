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
async function fetchAll(buildQuery) {
  const pageSize = 1000; let from = 0; let all = []
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
    if (from > 200000) break
  }
  return all
}

/**
 * Calcula a comissão por faixa de cada barbeiro num intervalo.
 * @param {object} opts { ini, fim }  ISO strings;  fim é EXCLUSIVO
 * @param {string|null} opts.unidade_id  filtra por unidade (null = todas)
 * @returns {Promise<{linhas:Array, total_comissao:number, total_servico:number, total_produto:number}>}
 */
async function calcularComissaoFaixa({ ini, fim, unidade_id = null }) {
  const itens = await fetchAll(() => {
    let q = supabaseAdmin
      .from('itens_comanda')
      .select('tipo, produto_id, quantidade, valor_unit, colaborador_id, comandas!inner(colaborador_id, unidade_id, status, finalizada_em)')
      .eq('comandas.status', 'finalizada')
      .gte('comandas.finalizada_em', ini)
      .lt('comandas.finalizada_em', fim)
    if (unidade_id) q = q.eq('comandas.unidade_id', unidade_id)
    return q
  })

  // Produtos de categorias que NÃO pagam comissão (ex.: Bar): contam só no
  // faturamento da unidade, nunca na comissão do barbeiro.
  let barProdIds = new Set()
  {
    const { data: barCats } = await supabaseAdmin
      .from('categorias_produto').select('id').eq('paga_comissao', false)
    const catIds = (barCats || []).map(c => c.id)
    if (catIds.length) {
      const { data: bp } = await supabaseAdmin
        .from('produtos').select('id').in('categoria_id', catIds)
      barProdIds = new Set((bp || []).map(p => p.id))
    }
  }

  // Agrega por barbeiro
  const acc = {}
  for (const it of (itens || [])) {
    // barbeiro do ITEM (ex.: produto de barbearia vendido por outro barbeiro);
    // se o item não tiver, cai no barbeiro da comanda (comportamento antigo).
    const cid = it.colaborador_id || (it.comandas && it.comandas.colaborador_id)
    if (!cid) continue
    if (it.produto_id && barProdIds.has(it.produto_id)) continue // Bar: não paga comissão
    if (!acc[cid]) acc[cid] = { servico_total: 0, produto_total: 0, produto_unid: 0, plano_total: 0, servico_qtd: 0 }
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

  // AppBarber realizado FORA do sistema (não virou comanda): conta como SERVIÇO.
  // is('agendamento_id', null) garante que não duplica com comandas/agendamentos finalizados.
  const abs = await fetchAll(() => {
    let qab = supabaseAdmin
      .from('agenda_appbarber')
      .select('valor, colaborador_id')
      .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
      .gte('inicio', ini).lt('inicio', fim)
    if (unidade_id) qab = qab.eq('unidade_id', unidade_id)
    return qab
  })
  for (const a of (abs || [])) {
    const cid = a.colaborador_id
    if (!cid) continue
    if (!acc[cid]) acc[cid] = { servico_total: 0, produto_total: 0, produto_unid: 0, plano_total: 0, servico_qtd: 0 }
    acc[cid].servico_total += parseFloat(a.valor || 0)
    acc[cid].servico_qtd += 1
  }

  // Produtos IMPORTADOS do AppBarber (tabela espelho agenda_appbarber_produtos).
  // Antes NÃO entravam na comissão. Decisão do cliente:
  //  - contam só a partir de jun/2026 (não mexe no que o AppBarber já pagou no passado);
  //  - entram como produto normal e são recalculados pela FAIXA ATUAL do sistema;
  //  - Bar (comissao = 0) não entra.
  const PROD_IMPORT_DESDE = new Date('2026-06-01T00:00:00-03:00')   // ⬅️ data de corte (ajuste aqui se precisar)
  const _loProd = (new Date(ini) > PROD_IMPORT_DESDE ? new Date(ini) : PROD_IMPORT_DESDE).toISOString()
  if (new Date(_loProd) < new Date(fim)) {
    const prodsImp = await fetchAll(() => {
      let qp = supabaseAdmin
        .from('agenda_appbarber_produtos')
        .select('quantidade, valor_unit, colaborador_id')
        .gt('comissao', 0)                       // só barbearia (Bar = 0, não paga)
        .gte('data', _loProd).lt('data', fim)
      if (unidade_id) qp = qp.eq('unidade_id', unidade_id)
      return qp
    })
    for (const it of (prodsImp || [])) {
      const cid = it.colaborador_id
      if (!cid) continue
      if (!acc[cid]) acc[cid] = { servico_total: 0, produto_total: 0, produto_unid: 0, plano_total: 0, servico_qtd: 0 }
      const qtd = parseInt(it.quantidade) || 1
      acc[cid].produto_total += (parseFloat(it.valor_unit) || 0) * qtd
      acc[cid].produto_unid  += qtd
    }
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
