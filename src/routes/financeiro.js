const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const { calcularComissaoFaixa, limitesMes } = require('./comissao-faixa')
const SEM_ACESSO = exigirPerfil('proprietario', 'gerente')
const { exigirTela, exigirFuncao } = require('./permissoes')
const TELA_FIN = exigirTela('financeiro')
const TELA_DRE = exigirTela('dre')
const TELA_COMP = exigirTela('comparativo')

// ============================================================================
// ⚠️ REGRA DE OURO DESTE ARQUIVO: TODA consulta que pode devolver muitas linhas
// TEM que passar por fetchAll().
//
// O Supabase devolve no MÁXIMO 1000 linhas por vez. Sem paginação, a consulta
// não dá erro: ela simplesmente DEVOLVE MENOS e o relatório soma o que sobrou.
// Fica com cara de certo.
//
// Bug real (13/07/2026): o comparativo do PROPRIETÁRIO (que puxa as 3 unidades
// de uma vez, 1111 comandas no período) perdia 111 comandas no corte. O GERENTE,
// que filtra pela própria unidade (344), ficava abaixo de 1000 e via o número
// certo. Resultado: a mesma tela mostrava 314 para um e 344 para o outro.
//
// buildQuery() precisa montar a query DO ZERO a cada página.
// ============================================================================
async function fetchAll(buildQuery, max = 200000) {
  const pageSize = 1000
  let from = 0
  let all = []
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
    if (from > max) break
  }
  return all
}

// GET /financeiro/resumo?unidade_id=xxx&periodo=mes
router.get('/resumo', autenticar, SEM_ACESSO, TELA_FIN, async (req, res) => {
  try {
    const { unidade_id, periodo = 'mes' } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id
    // PAGINADO: sem isto, o proprietário (todas as unidades) perdia comandas no corte de 1000.
    const comandas = await fetchAll(() => {
      let q = supabaseAdmin
        .from('comandas')
        .select('total, forma_pgto, pagamentos, colaborador_id')
        .eq('status', 'finalizada')
        .gte('finalizada_em', ini).lte('finalizada_em', fim)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    const faturamento   = somar(comandas, 'total')
    // soma por forma: se a comanda foi dividida (pagamentos), distribui cada valor
    // na sua forma; senão, joga o total inteiro na forma_pgto (comportamento de sempre).
    const porForma = (forma) => comandas.reduce((s, c) => {
      if (Array.isArray(c.pagamentos) && c.pagamentos.length) {
        return s + c.pagamentos.reduce((ss, p) => ss + (p && p.forma === forma ? (Number(p.valor) || 0) : 0), 0)
      }
      return s + (c.forma_pgto === forma ? (Number(c.total) || 0) : 0)
    }, 0)
    const total_credito = porForma('credito')
    const total_debito  = porForma('debito')
    const total_pix     = porForma('pix')
    const total_dinheiro= porForma('dinheiro')
    // Comissão por FAIXA (serviço progressivo + produto por unidade) — mesmo motor do Caixa/Dashboard
    let comissoes = 0
    try {
      const fx = await calcularComissaoFaixa({ ini, fim, unidade_id: uid })
      comissoes = fx.total_comissao
    } catch (e) { console.error('[resumo comissoes-faixa]', e.message) }
    // AppBarber finalizado FORA do sistema (faturamento — observação)
    const ab = await appbarberRealizados(ini, fim, uid)
    const abFaturamento = somar(ab, 'valor')
    const abComissao = 0 // já incluído no cálculo por faixa (vira comanda com itens)
    // ---- Quebra do faturamento: SERVIÇOS / PRODUTOS BARBEARIA / BAR ----
    // produtos de Bar = categorias que NÃO pagam comissão
    let barProdIds = new Set()
    {
      const { data: barCats } = await supabaseAdmin.from('categorias_produto').select('id').eq('paga_comissao', false)
      const catIds = (barCats || []).map(c => c.id)
      if (catIds.length) {
        const { data: bp } = await supabaseAdmin.from('produtos').select('id').in('categoria_id', catIds)
        barProdIds = new Set((bp || []).map(p => p.id))
      }
    }
    // itens das comandas finalizadas no período — PAGINADO
    const itensFat = await fetchAll(() => {
      let q = supabaseAdmin
        .from('itens_comanda')
        .select('comanda_id, tipo, produto_id, quantidade, valor_unit, comandas!inner(unidade_id, status, finalizada_em)')
        .eq('comandas.status', 'finalizada')
        .gte('comandas.finalizada_em', ini).lte('comandas.finalizada_em', fim)
      if (uid) q = q.eq('comandas.unidade_id', uid)
      return q
    })
    let fatServicos = 0, fatBarbearia = 0, fatBar = 0
    // ATENDIMENTO = comanda com item de SERVIÇO (tipo != 'produto'). Venda só de bar não conta.
    const comServicoResumo = new Set()
    ;(itensFat || []).forEach(it => {
      const v = (parseFloat(it.valor_unit) || 0) * (parseInt(it.quantidade) || 1)
      const tipo = String(it.tipo || '').toLowerCase()
      if (tipo.indexOf('produto') !== -1) {
        if (it.produto_id && barProdIds.has(it.produto_id)) fatBar += v
        else fatBarbearia += v
      } else {
        fatServicos += v   // serviço + plano (mensalidade)
        if (it.comanda_id) comServicoResumo.add(it.comanda_id)
      }
    })
    fatServicos += abFaturamento   // serviços realizados no AppBarber
    // produtos importados do AppBarber (comissao > 0 = barbearia; 0 = bar) — PAGINADO
    const abProd = await fetchAll(() => {
      let q = supabaseAdmin
        .from('agenda_appbarber_produtos')
        .select('quantidade, valor_unit, comissao, unidade_id, data')
        .gte('data', ini).lte('data', fim)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    ;(abProd || []).forEach(p => {
      const v = (parseFloat(p.valor_unit) || 0) * (parseInt(p.quantidade) || 1)
      if ((parseFloat(p.comissao) || 0) > 0) fatBarbearia += v
      else fatBar += v
    })
    const faturamentoTotal = fatServicos + fatBarbearia + fatBar
    const comissoesTotal   = comissoes + abComissao
    const atendimentos     = comServicoResumo.size + ab.length
    return res.json({
      periodo,
      faturamento:    round(faturamentoTotal),
      fat_servicos:        round(fatServicos),
      fat_prod_barbearia:  round(fatBarbearia),
      fat_bar:             round(fatBar),
      comissoes:      round(comissoesTotal),
      liquido:        round(faturamentoTotal - comissoesTotal),
      total_comandas: atendimentos,
      ticket_medio:   atendimentos ? round(fatServicos / atendimentos) : 0,
      faturamento_appbarber: round(abFaturamento),  // observação: pago no AppBarber
      comissao_appbarber:    round(abComissao),
      formas: {
        credito:  round(total_credito),
        debito:   round(total_debito),
        pix:      round(total_pix),
        dinheiro: round(total_dinheiro),
        appbarber: round(abFaturamento)             // pago fora do caixa do sistema
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao buscar resumo financeiro' })
  }
})
// GET /financeiro/comissoes-faixa?mes=YYYY-MM&unidade_id=xxx
// Comissão por faixa (serviço progressivo + produto por unidade), por barbeiro, no mês.
router.get('/comissoes-faixa', autenticar, async (req, res) => {
  try {
    const u = req.usuario
    const mesQ = (req.query.mes || '').match(/^\d{4}-\d{2}$/) ? (req.query.mes + '-15') : null
    const { ini, fim } = limitesMes(mesQ)
    const unidade_id = (u.perfil === 'proprietario') ? (req.query.unidade_id || null) : (u.unidade_id || null)
    const r = await calcularComissaoFaixa({ ini, fim, unidade_id })
    return res.json({ mes: ini.slice(0, 7), ...r })
  } catch (err) {
    console.error('[comissoes-faixa]', err.message)
    return res.status(500).json({ erro: 'Erro ao calcular comissões por faixa' })
  }
})
// GET /financeiro/comissoes?periodo=mes
router.get('/comissoes', autenticar, SEM_ACESSO, exigirFuncao('ver_comissoes'), async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id
    const { data, error } = await supabaseAdmin
      .from('vw_comissoes_mes')
      .select('*')
      .gte('mes', ini).lte('mes', fim)
    if (uid) {
      const filtered = (data || []).filter(r => r.unidade_nome !== undefined)
      return res.json(filtered)
    }
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comissões' })
  }
})
// GET /financeiro/comissao-propria?periodo=mes — barbeiro vê a própria
router.get('/comissao-propria', autenticar, exigirPerfil('colaborador', 'gerente'), async (req, res) => {
  try {
    const { periodo = 'mes' } = req.query
    const { ini, fim } = getPeriodo(periodo)
    const { data: col } = await supabaseAdmin
      .from('colaboradores').select('comissao_pct').eq('id', req.usuario.id).single()
    if (!col) return res.status(404).json({ erro: 'Colaborador não encontrado' })
    // PAGINADO (períodos longos passam de 1000 comandas)
    const comandas = await fetchAll(() =>
      supabaseAdmin
        .from('comandas').select('total')
        .eq('colaborador_id', req.usuario.id)
        .eq('status', 'finalizada')
        .gte('finalizada_em', ini).lte('finalizada_em', fim)
    )
    const faturado  = somar(comandas || [], 'total')
    const comissao  = round(faturado * col.comissao_pct / 100)
    return res.json({
      periodo,
      total_comandas: (comandas || []).length,
      faturado:       round(faturado),
      comissao_pct:   col.comissao_pct,
      comissao
    })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar comissão' })
  }
})
// GET /relatorios/servicos?periodo=mes
router.get('/relatorios/servicos', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const { ini, fim } = getPeriodo(periodo)
    // CORRIGIDO: antes buscava a tabela itens_comanda INTEIRA (sem filtro de data no
    // banco, sem paginação) e filtrava a data só no JavaScript. Com mais de 1000 itens
    // na tabela, o Supabase cortava em 1000 ANTES do filtro rodar -> o relatório mostrava
    // uma fração do período, sempre. Agora filtra e pagina no banco.
    const filtrado = await fetchAll(() => {
      let q = supabaseAdmin
        .from('itens_comanda')
        .select('descricao, quantidade, valor_unit, servico_id, comandas!inner(unidade_id, finalizada_em, status)')
        .eq('tipo', 'servico')
        .not('servico_id', 'is', null)
        .eq('comandas.status', 'finalizada')
        .gte('comandas.finalizada_em', ini).lte('comandas.finalizada_em', fim)
      if (unidade_id) q = q.eq('comandas.unidade_id', unidade_id)
      return q
    })
    // Agrupa por serviço
    const mapa = {}
    filtrado.forEach(i => {
      if (!mapa[i.descricao]) mapa[i.descricao] = { nome: i.descricao, quantidade: 0, faturado: 0 }
      mapa[i.descricao].quantidade += (parseInt(i.quantidade) || 1)
      mapa[i.descricao].faturado   += (parseFloat(i.valor_unit)||0) * (parseInt(i.quantidade)||1)
    })
    const ranking = Object.values(mapa)
      .map(r => ({ ...r, faturado: round(r.faturado) }))
      .sort((a, b) => b.faturado - a.faturado)
    return res.json(ranking)
  } catch (err) {
    console.error('[relatorios/servicos]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar relatório de serviços' })
  }
})
// GET /relatorios/retencao
router.get('/relatorios/retencao', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vw_clientes_reativar').select('*')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar retenção' })
  }
})
// GET /relatorios/estoque-alertas
router.get('/relatorios/estoque', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('vw_estoque_alertas').select('*')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar estoque' })
  }
})
// GET /financeiro/comissoes-barbeiro?periodo=mes&unidade_id=xxx — comissão real por barbeiro
router.get('/comissoes-barbeiro', autenticar, SEM_ACESSO, exigirFuncao('ver_comissoes'), async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id
    const fx = await calcularComissaoFaixa({ ini, fim, unidade_id: uid })
    // nº de atendimentos (comandas finalizadas) e unidade por barbeiro — PAGINADO
    const cmds = await fetchAll(() => {
      let q = supabaseAdmin.from('comandas').select('colaborador_id, unidade_id')
        .eq('status', 'finalizada').gte('finalizada_em', ini).lte('finalizada_em', fim)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    const cont = {}, unidDe = {}
    ;(cmds || []).forEach(c => {
      cont[c.colaborador_id] = (cont[c.colaborador_id] || 0) + 1
      if (!unidDe[c.colaborador_id]) unidDe[c.colaborador_id] = c.unidade_id
    })
    const { data: unidades } = await supabaseAdmin.from('unidades').select('id, nome')
    const unome = (id) => { const un = (unidades || []).find(x => x.id === id); return un ? un.nome.replace('Unidade ', '') : '' }
    // DESCONTOS do período por colaborador = vales (consumo de produto) + vales_pix (adiantamentos)
    const descPorColab = {}
    const somaVales = (rows) => (rows || []).forEach(v => {
      descPorColab[v.colaborador_id] = (descPorColab[v.colaborador_id] || 0) + (parseFloat(v.valor) || 0)
    })
    try {
      const { data: vProd } = await supabaseAdmin.from('vales').select('colaborador_id, valor').gte('criado_em', ini).lte('criado_em', fim)
      somaVales(vProd)
    } catch (e) { console.error('[comissoes-barbeiro vales]', e.message) }
    try {
      const { data: vPix } = await supabaseAdmin.from('vales_pix').select('colaborador_id, valor').gte('criado_em', ini).lte('criado_em', fim)
      somaVales(vPix)
    } catch (e) { console.error('[comissoes-barbeiro vales_pix]', e.message) }
    const lista = (fx.linhas || []).map(l => {
      const descontos = round(descPorColab[l.colaborador_id] || 0)
      return {
      nome: l.nome,
      unidade: unome(unidDe[l.colaborador_id]) || l.unidade || '',
      atendimentos: cont[l.colaborador_id] || 0,
      faturado: round(l.servico_total + l.produto_total),
      comissao_pct: l.servico_pct,
      comissao: l.comissao_total,
      descontos: descontos,
      a_receber: round((l.comissao_total || 0) - descontos),
      servico_total: l.servico_total, servico_pct: l.servico_pct, servico_comissao: l.servico_comissao,
      produto_total: l.produto_total, produto_unidades: l.produto_unidades, produto_pct: l.produto_pct, produto_comissao: l.produto_comissao,
      ab_faturado: 0
      }
    }).sort((a, b) => b.comissao - a.comissao)
    return res.json(lista)
  } catch (err) {
    console.error('[comissoes-barbeiro]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar comissões por barbeiro' })
  }
})
// GET /financeiro/por-unidade?periodo=mes — faturamento e atendimentos reais por unidade
router.get('/por-unidade', autenticar, SEM_ACESSO, TELA_COMP, async (req, res) => {
  try {
    const { periodo = 'mes' } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    // PAGINADO: o proprietário puxa as 3 unidades de uma vez — passava de 1000 e truncava.
    const comandas = await fetchAll(() => {
      let q = supabaseAdmin
        .from('comandas').select('id, total, unidade_id, colaborador_id')
        .eq('status', 'finalizada').gte('finalizada_em', ini).lte('finalizada_em', fim)
      if (u.perfil !== 'proprietario' && u.unidade_id) q = q.eq('unidade_id', u.unidade_id)
      return q
    })
    // ATENDIMENTO = comanda com pelo menos 1 item de SERVIÇO (tipo != 'produto').
    // Venda só de bar não conta como atendimento (nem o caixa/quem operou vira "barbeiro").
    const comServicoU = await fetchAll(() => {
      let q = supabaseAdmin.from('itens_comanda')
        .select('comanda_id, comandas!inner(status, finalizada_em, unidade_id)')
        .neq('tipo', 'produto')
        .eq('comandas.status', 'finalizada')
        .gte('comandas.finalizada_em', ini).lte('comandas.finalizada_em', fim)
      if (u.perfil !== 'proprietario' && u.unidade_id) q = q.eq('comandas.unidade_id', u.unidade_id)
      return q
    })
    const setServicoU = new Set((comServicoU || []).map(i => i.comanda_id))
    const { data: unidades } = await supabaseAdmin.from('unidades').select('id, nome')
    const mapa = {}
    ;(comandas || []).forEach(c => {
      if (!c.unidade_id) return
      if (!mapa[c.unidade_id]) mapa[c.unidade_id] = { atendimentos: 0, faturado: 0, ab_faturado: 0, barbeiros: new Set() }
      mapa[c.unidade_id].faturado += parseFloat(c.total || 0)
      if (setServicoU.has(c.id)) {
        mapa[c.unidade_id].atendimentos += 1
        if (c.colaborador_id) mapa[c.unidade_id].barbeiros.add(c.colaborador_id)
      }
    })
    // AppBarber finalizado fora do sistema
    const abUid = u.perfil === 'proprietario' ? null : u.unidade_id
    const ab = await appbarberRealizados(ini, fim, abUid)
    ;(ab || []).forEach(a => {
      if (!a.unidade_id) return
      if (!mapa[a.unidade_id]) mapa[a.unidade_id] = { atendimentos: 0, faturado: 0, ab_faturado: 0, barbeiros: new Set() }
      mapa[a.unidade_id].atendimentos += 1
      mapa[a.unidade_id].faturado += parseFloat(a.valor || 0)
      mapa[a.unidade_id].ab_faturado += parseFloat(a.valor || 0)
      if (a.colaborador_id) mapa[a.unidade_id].barbeiros.add(a.colaborador_id)
    })
    const lista = Object.keys(mapa).map(uid => {
      const un = (unidades || []).find(x => x.id === uid)
      return {
        nome: (un ? un.nome : 'Unidade').replace('Unidade ', ''),
        atendimentos: mapa[uid].atendimentos,
        faturado: round(mapa[uid].faturado),
        ab_faturado: round(mapa[uid].ab_faturado || 0),
        barbeiros: mapa[uid].barbeiros.size
      }
    }).sort((a, b) => b.faturado - a.faturado)
    return res.json(lista)
  } catch (err) {
    console.error('[por-unidade]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar faturamento por unidade' })
  }
})
// GET /financeiro/produtos?periodo=mes&unidade_id=xxx — venda de produtos real
router.get('/produtos', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const { periodo = 'mes', unidade_id } = req.query
    const u = req.usuario
    const { ini, fim } = getPeriodo(periodo)
    const uid = u.perfil === 'proprietario' ? unidade_id : u.unidade_id
    // CORRIGIDO: antes buscava itens_comanda INTEIRA (sem filtro de data no banco e sem
    // paginação) e filtrava no JavaScript -> com +1000 itens na tabela, o corte acontecia
    // ANTES do filtro e o relatório mostrava uma fração do período. Agora filtra e pagina no banco.
    const filt = await fetchAll(() => {
      let q = supabaseAdmin
        .from('itens_comanda')
        .select('descricao, quantidade, valor_unit, comandas!inner(unidade_id, finalizada_em, status)')
        .eq('tipo', 'produto')
        .eq('comandas.status', 'finalizada')
        .gte('comandas.finalizada_em', ini).lte('comandas.finalizada_em', fim)
      if (uid) q = q.eq('comandas.unidade_id', uid)
      return q
    })
    const mapa = {}; let total = 0
    filt.forEach(i => {
      if (!mapa[i.descricao]) mapa[i.descricao] = { nome: i.descricao, quantidade: 0, faturado: 0 }
      const _q = parseInt(i.quantidade) || 1
      mapa[i.descricao].quantidade += _q
      const _vt = (parseFloat(i.valor_unit)||0) * _q
      mapa[i.descricao].faturado += _vt
      total += _vt
    })
    // Produtos vendidos no AppBarber (espelho) no período — PAGINADO
    const abProd = await fetchAll(() => {
      let q = supabaseAdmin
        .from('agenda_appbarber_produtos')
        .select('descricao, quantidade, valor_unit, unidade_id, data')
        .gte('data', ini).lte('data', fim)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    ;(abProd || []).forEach(i => {
      const nome = i.descricao || 'Produto'
      if (!mapa[nome]) mapa[nome] = { nome, quantidade: 0, faturado: 0 }
      const q = parseInt(i.quantidade) || 1
      const v = (parseFloat(i.valor_unit) || 0) * q
      mapa[nome].quantidade += q
      mapa[nome].faturado += v
      total += v
    })
    const ranking = Object.values(mapa).map(r => ({ ...r, faturado: round(r.faturado) })).sort((a, b) => b.faturado - a.faturado)
    return res.json({ total: round(total), ranking })
  } catch (err) {
    console.error('[produtos]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar venda de produtos' })
  }
})
// Helpers
function getPeriodo(periodo) {
  // Dia específico: "dia:AAAA-MM-DD" -> aquele dia inteiro (horário de São Paulo)
  const mDia = String(periodo || '').match(/^dia:(\d{4}-\d{2}-\d{2})$/)
  if (mDia) {
    const d = mDia[1]
    return { ini: d + 'T00:00:00-03:00', fim: d + 'T23:59:59.999-03:00' }
  }
  // Intervalo livre: "range:AAAA-MM-DD:AAAA-MM-DD" -> do dia 1 (00:00) ao dia 2 (23:59) em SP
  const mRange = String(periodo || '').match(/^range:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/)
  if (mRange) {
    let d1 = mRange[1], d2 = mRange[2]
    if (d2 < d1) { const t = d1; d1 = d2; d2 = t }   // inverteu? corrige
    return { ini: d1 + 'T00:00:00-03:00', fim: d2 + 'T23:59:59.999-03:00' }
  }
  const agora = new Date()
  let ini, fim
  if (periodo === 'hoje') {
    ini = new Date(agora.setHours(0,0,0,0)).toISOString()
    fim = new Date(agora.setHours(23,59,59,999)).toISOString()
  } else if (periodo === 'semana') {
    const dom = new Date(agora)
    dom.setDate(agora.getDate() - agora.getDay())
    dom.setHours(0,0,0,0)
    ini = dom.toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'mes') {
    ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'trim') {
    const m = Math.floor(agora.getMonth() / 3) * 3
    ini = new Date(agora.getFullYear(), m, 1).toISOString()
    fim = new Date().toISOString()
  } else if (periodo === 'ano') {
    ini = new Date(agora.getFullYear(), 0, 1).toISOString()
    fim = new Date().toISOString()
  } else {
    ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    fim = new Date().toISOString()
  }
  return { ini, fim }
}
function somar(arr, campo) {
  return (arr || []).reduce((s, r) => s + parseFloat(r[campo] || 0), 0)
}
function round(n) {
  return Math.round(n * 100) / 100
}
// Agendamentos do AppBarber FINALIZADOS FORA do sistema (pagos no AppBarber):
//  tipo=agendamento, status=realizado, e SEM comanda no sistema (agendamento_id IS NULL).
//  Entram no faturamento/comissão como "observação" (não passaram pelo caixa físico).
async function appbarberRealizados(ini, fim, uid) {
  return fetchAll(() => {
    let q = supabaseAdmin.from('agenda_appbarber')
      .select('valor, colaborador_id, unidade_id, inicio')
      .eq('tipo', 'agendamento')
      .is('agendamento_id', null)
      .eq('status', 'realizado')
      .gte('inicio', ini).lte('inicio', fim)
    if (uid) q = q.eq('unidade_id', uid)
    return q
  })
}
// Classifica produto pelo NOME: Barbearia (pomada, shampoo, etc.) x Bar (bebida,
// chocolate). Comissão não serve (tem exceção); o nome é confiável.
function ehProdutoBarbearia(nome) {
  const s = String(nome || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return /(balm|cera|oleo|pomada|redensyl|shampoo)/.test(s)
}
// GET /financeiro/comparativo?mes1=2026-03&mes2=2026-04[&unidade_id=xxx]
// Comparativo mês x mês por BARBEIRO e por UNIDADE.
// Métricas: atendimentos, produtos (qtd), serviços (R$), produtos/bar (R$), geral (R$), ticket médio.
// Fonte: comandas finalizadas + AppBarber realizado (igual ao restante do Financeiro).
router.get('/comparativo', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const hoje = new Date()
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
    const mesAtual = ym(hoje)
    const mesAnterior = ym(new Date(hoje.getFullYear(), hoje.getMonth()-1, 1))
    const mes1 = req.query.mes1 || mesAnterior
    const mes2 = req.query.mes2 || mesAtual
    const uidFiltro = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || null)
    const rangeMes = (mes) => {
      const [y,m] = mes.split('-').map(Number)
      const prox = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`
      return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
    }
    // Datas livres: fim é INCLUSIVO (conta o dia inteiro) -> usa o dia seguinte como limite exclusivo.
    const rangeDatas = (iniYMD, fimYMD) => {
      const f = new Date(fimYMD + 'T12:00:00-03:00'); f.setDate(f.getDate() + 1)
      const fimExcl = f.toISOString().slice(0, 10)
      return { ini: `${iniYMD}T00:00:00-03:00`, fim: `${fimExcl}T00:00:00-03:00` }
    }
    const usarDatas = !!(req.query.ini1 && req.query.fim1 && req.query.ini2 && req.query.fim2)
    const range1 = usarDatas ? rangeDatas(req.query.ini1, req.query.fim1) : rangeMes(mes1)
    const range2 = usarDatas ? rangeDatas(req.query.ini2, req.query.fim2) : rangeMes(mes2)
    const _fmtBR = (ymd) => { const p = String(ymd).split('-'); return p[2] + '/' + p[1] + '/' + p[0].slice(2) }
    const periodo1 = usarDatas ? (_fmtBR(req.query.ini1) + '–' + _fmtBR(req.query.fim1)) : null
    const periodo2 = usarDatas ? (_fmtBR(req.query.ini2) + '–' + _fmtBR(req.query.fim2)) : null
    let qCol = supabaseAdmin.from('colaboradores').select('id, nome, unidade_id')
    if (uidFiltro) qCol = qCol.eq('unidade_id', uidFiltro)
    const { data: colabs } = await qCol
    let qUni = supabaseAdmin.from('unidades').select('id, nome')
    if (uidFiltro) qUni = qUni.eq('id', uidFiltro)
    const { data: unids } = await qUni
    // Produtos de categorias que NÃO pagam comissão (Bar) — identifica por id e por nome.
    const _normProd = (s) => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim()
    let barProdIds = new Set(), barProdNomes = new Set()
    {
      const { data: barCats } = await supabaseAdmin
        .from('categorias_produto').select('id').eq('paga_comissao', false)
      const catIds = (barCats||[]).map(c=>c.id)
      if (catIds.length) {
        const { data: bp } = await supabaseAdmin
          .from('produtos').select('id, nome').in('categoria_id', catIds)
        barProdIds   = new Set((bp||[]).map(p=>p.id))
        barProdNomes = new Set((bp||[]).map(p=>_normProd(p.nome)))
      }
    }
    // true = produto de barbearia (paga comissão); false = bar (não paga)
    const ehBarbearia = (produto_id, descricao) =>
      !((produto_id && barProdIds.has(produto_id)) || barProdNomes.has(_normProd(descricao)))
    const vazio = () => ({ atend:0, prod_qtd:0, valor_serv:0, valor_prod:0,
      prod_barb_qtd:0, prod_barb_valor:0, prod_bar_qtd:0, prod_bar_valor:0 })
    async function metricasPeriodo(range) {
      const { ini, fim } = range
      const porColab = {}, porUni = {}
      const eC = (id) => (porColab[id] = porColab[id] || vazio())
      const eU = (id) => (porUni[id]   = porUni[id]   || vazio())
      // Comandas finalizadas → atendimentos.
      // ⚠️ PAGINADO. ERA AQUI O BUG: sem paginação, o PROPRIETÁRIO (que puxa as 3 unidades)
      // passava de 1000 comandas no período e o Supabase cortava — os atendimentos saíam
      // a MENOS. O GERENTE, filtrado numa unidade só, ficava abaixo de 1000 e via o certo.
      // A mesma tela mostrava 314 para um e 344 para o outro.
      const cmds = await fetchAll(() => {
        let q = supabaseAdmin.from('comandas')
          .select('id, colaborador_id, unidade_id')
          .eq('status','finalizada').gte('finalizada_em', ini).lt('finalizada_em', fim)
        if (uidFiltro) q = q.eq('unidade_id', uidFiltro)
        return q
      })
      // Itens (serviço x produto) — paginado e com filtro de data NO BANCO.
      const itens = await fetchAll(() => {
        let q = supabaseAdmin.from('itens_comanda')
          .select('comanda_id, tipo, produto_id, descricao, valor_unit, quantidade, comandas!inner(colaborador_id, unidade_id, finalizada_em, status)')
          .eq('comandas.status', 'finalizada')
          .gte('comandas.finalizada_em', ini)
          .lt('comandas.finalizada_em', fim)
        if (uidFiltro) q = q.eq('comandas.unidade_id', uidFiltro)
        return q
      })
      // ATENDIMENTO = comanda com pelo menos 1 item de SERVIÇO (tipo != 'produto').
      // Venda só de bar/produto NÃO é atendimento (o caixa opera venda de bar e não atende;
      // barbeiro que vende um refri também não ganha atendimento por isso).
      const comandasComServico = new Set()
      for (const i of (itens||[])) {
        if (i && i.tipo !== 'produto' && i.comanda_id) comandasComServico.add(i.comanda_id)
      }
      for (const c of (cmds||[])) {
        if (!comandasComServico.has(c.id)) continue
        if (c.colaborador_id) eC(c.colaborador_id).atend++
        if (c.unidade_id)     eU(c.unidade_id).atend++
      }
      for (const i of (itens||[])) {
        const c = i.comandas
        if (!c || c.status !== 'finalizada') continue
        if (!(c.finalizada_em >= ini && c.finalizada_em < fim)) continue
        if (uidFiltro && c.unidade_id !== uidFiltro) continue
        const q = parseInt(i.quantidade) || 1
        const v = (parseFloat(i.valor_unit)||0) * q
        if (i.tipo === 'produto') {
          const barb = ehBarbearia(i.produto_id, i.descricao)
          const add = (x) => {
            x.valor_prod+=v; x.prod_qtd+=q
            if (barb){ x.prod_barb_valor+=v; x.prod_barb_qtd+=q } else { x.prod_bar_valor+=v; x.prod_bar_qtd+=q }
          }
          if (c.colaborador_id) add(eC(c.colaborador_id))
          if (c.unidade_id)     add(eU(c.unidade_id))
        } else {
          if (c.colaborador_id) eC(c.colaborador_id).valor_serv += v
          if (c.unidade_id)     eU(c.unidade_id).valor_serv += v
        }
      }
      // AppBarber realizado (pago fora) → serviço + atendimento
      const ab = await appbarberRealizados(ini, fim, uidFiltro)
      for (const a of ab) {
        const v = parseFloat(a.valor) || 0
        if (a.colaborador_id){ const x=eC(a.colaborador_id); x.valor_serv+=v; x.atend++ }
        if (a.unidade_id)    { const y=eU(a.unidade_id);     y.valor_serv+=v; y.atend++ }
      }
      // AppBarber PRODUTOS (espelho das comandas) → produto + quantidade — PAGINADO
      const abProd = await fetchAll(() => {
        let q = supabaseAdmin.from('agenda_appbarber_produtos')
          .select('descricao, valor_unit, quantidade, colaborador_id, unidade_id, data')
          .gte('data', ini).lt('data', fim)
        if (uidFiltro) q = q.eq('unidade_id', uidFiltro)
        return q
      })
      for (const p of (abProd||[])) {
        const q = parseInt(p.quantidade) || 1
        const v = (parseFloat(p.valor_unit)||0) * q
        const barb = ehBarbearia(null, p.descricao)
        const add = (x) => {
          x.valor_prod+=v; x.prod_qtd+=q
          if (barb){ x.prod_barb_valor+=v; x.prod_barb_qtd+=q } else { x.prod_bar_valor+=v; x.prod_bar_qtd+=q }
        }
        if (p.colaborador_id) add(eC(p.colaborador_id))
        if (p.unidade_id)     add(eU(p.unidade_id))
      }
      return { porColab, porUni }
    }
    const M1 = await metricasPeriodo(range1)
    const M2 = await metricasPeriodo(range2)
    const finaliza = (m) => ({
      atend: m.atend, prod_qtd: m.prod_qtd,
      valor_serv: m.valor_serv, valor_prod: m.valor_prod,
      prod_barb_qtd: m.prod_barb_qtd, prod_barb_valor: m.prod_barb_valor,
      prod_bar_qtd: m.prod_bar_qtd, prod_bar_valor: m.prod_bar_valor,
      geral: m.valor_serv + m.valor_prod,
      ticket: m.atend > 0 ? m.valor_serv / m.atend : 0
    })
    const nomeUni = {}; (unids||[]).forEach(x => nomeUni[x.id] = x.nome)
    // BARBEIROS (só os que tiveram movimento em algum dos meses)
    const idsColab = new Set([...Object.keys(M1.porColab), ...Object.keys(M2.porColab)])
    const barbeiros = (colabs||[])
      .filter(col => idsColab.has(col.id))
      .map(col => ({
        id: col.id, nome: col.nome,
        unidade_id: col.unidade_id, unidade_nome: nomeUni[col.unidade_id] || '—',
        m1: finaliza(M1.porColab[col.id] || vazio()),
        m2: finaliza(M2.porColab[col.id] || vazio())
      }))
      .sort((a,b) => (a.unidade_nome||'').localeCompare(b.unidade_nome||'') || b.m2.geral - a.m2.geral)
    // UNIDADES
    const idsUni = new Set([...Object.keys(M1.porUni), ...Object.keys(M2.porUni), ...(unids||[]).map(x=>x.id)])
    const unidades = [...idsUni]
      .filter(uid => !uidFiltro || uid === uidFiltro)
      .map(uid => ({
        id: uid, nome: nomeUni[uid] || '—',
        m1: finaliza(M1.porUni[uid] || vazio()),
        m2: finaliza(M2.porUni[uid] || vazio())
      }))
      .sort((a,b) => b.m2.geral - a.m2.geral)
    const somar = (lista, chave) => {
      const t = { atend:0, prod_qtd:0, valor_serv:0, valor_prod:0, geral:0,
        prod_barb_qtd:0, prod_barb_valor:0, prod_bar_qtd:0, prod_bar_valor:0 }
      lista.forEach(r => {
        t.atend+=r[chave].atend; t.prod_qtd+=r[chave].prod_qtd
        t.valor_serv+=r[chave].valor_serv; t.valor_prod+=r[chave].valor_prod; t.geral+=r[chave].geral
        t.prod_barb_qtd+=r[chave].prod_barb_qtd; t.prod_barb_valor+=r[chave].prod_barb_valor
        t.prod_bar_qtd+=r[chave].prod_bar_qtd; t.prod_bar_valor+=r[chave].prod_bar_valor
      })
      t.ticket = t.atend > 0 ? t.valor_serv / t.atend : 0
      return t
    }
    return res.json({
      mes1, mes2, periodo1, periodo2, barbeiros, unidades,
      totais: { m1: somar(unidades,'m1'), m2: somar(unidades,'m2') }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao gerar comparativo' })
  }
})
// ===================== DRE / BALANCETE =====================
// Categorias de despesa padrão (COMISSÃO é calculada à parte, automática)
const DRE_CATEGORIAS = ['ATENDENTE','GERENTE','ADMINISTRADOR','LIMPEZA','EXTRA','ALUGUEL','MERCADO','GIRO','LF','INSUMOS','MARKETING','CONTADOR','IMPOSTOS','PRODUTOS','LUZ','AGUA','INTERNET/SPOTIFY','SEGURANÇA','DIV/BAR']
const DRE_FORMAS = [['Dinheiro','dinheiro'],['Débito','debito'],['Crédito','credito'],['Pix','pix'],['AppBarber','appbarber'],['Outros','outros']]
function rangeMesDre(mes) {
  const [y,m] = mes.split('-').map(Number)
  const prox = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`
  return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
}
// Entrada (por forma) e comissão calculadas automaticamente do sistema
async function autoDre(ini, fim, uid) {
  // PAGINADO: sem isto, o DRE consolidado (todas as unidades) truncava em 1000 comandas
  // e a ENTRADA e a COMISSÃO do balancete saíam a menos.
  const cmds = await fetchAll(() => {
    let q = supabaseAdmin.from('comandas').select('total, forma_pgto, pagamentos, colaborador_id')
      .eq('status','finalizada').gte('finalizada_em', ini).lt('finalizada_em', fim)
    if (uid) q = q.eq('unidade_id', uid)
    return q
  })
  const { data: cols } = await supabaseAdmin.from('colaboradores').select('id, comissao_pct')
  const pctMap = {}; (cols||[]).forEach(c => pctMap[c.id] = (c.comissao_pct != null ? c.comissao_pct : 40) / 100)
  const entrada = { dinheiro:0, debito:0, credito:0, pix:0, appbarber:0, outros:0 }
  let comissao = 0
  for (const c of (cmds||[])) {
    const v = parseFloat(c.total)||0
    if (Array.isArray(c.pagamentos) && c.pagamentos.length) {
      for (const p of c.pagamentos) {
        const pf = ['dinheiro','debito','credito','pix'].includes(p && p.forma) ? p.forma : 'outros'
        entrada[pf] += (parseFloat(p && p.valor) || 0)
      }
    } else {
      const f = ['dinheiro','debito','credito','pix'].includes(c.forma_pgto) ? c.forma_pgto : 'outros'
      entrada[f] += v
    }
    comissao += v * (pctMap[c.colaborador_id] || 0.4)
  }
  const ab = await appbarberRealizados(ini, fim, uid)
  for (const a of ab) {
    const v = parseFloat(a.valor)||0
    entrada.appbarber += v
    comissao += v * (pctMap[a.colaborador_id] || 0.4)
  }
  return { entrada, comissao }
}
// Monta o DRE de UMA unidade (mistura automático com o que foi salvo)
async function montarDre(uid, mes) {
  const { ini, fim } = rangeMesDre(mes)
  const { entrada: autoEnt, comissao: comAuto } = await autoDre(ini, fim, uid)
  const { data: linhas } = await supabaseAdmin.from('dre_lancamentos')
    .select('tipo, categoria, valor').eq('unidade_id', uid).eq('mes', mes)
  const savedEnt = {}, savedDesp = {}
  ;(linhas||[]).forEach(l => { (l.tipo==='entrada'?savedEnt:savedDesp)[l.categoria] = parseFloat(l.valor)||0 })
  const salvo = (linhas||[]).length > 0
  const entrada = DRE_FORMAS.map(([label,key]) => ({
    categoria: label,
    auto: round(autoEnt[key]||0),
    valor: savedEnt[label] != null ? savedEnt[label] : round(autoEnt[key]||0)
  }))
  const despesas = []
  despesas.push({ categoria:'COMISSÃO', comissao:true, auto: round(comAuto),
    valor: savedDesp['COMISSÃO'] != null ? savedDesp['COMISSÃO'] : round(comAuto) })
  DRE_CATEGORIAS.forEach(cat => despesas.push({ categoria:cat, valor: savedDesp[cat] != null ? savedDesp[cat] : 0 }))
  Object.keys(savedDesp).forEach(cat => {
    if (cat !== 'COMISSÃO' && !DRE_CATEGORIAS.includes(cat)) despesas.push({ categoria:cat, valor: savedDesp[cat], custom:true })
  })
  return { entrada, despesas, salvo }
}
function finalizaDre(mes, unidade_id, dre, consolidado) {
  const total_entrada = dre.entrada.reduce((s,e)=>s+(parseFloat(e.valor)||0),0)
  const total_despesa = dre.despesas.reduce((s,d)=>s+(parseFloat(d.valor)||0),0)
  return {
    mes, unidade_id, consolidado, salvo: dre.salvo,
    entrada: dre.entrada.map(e => ({ ...e, valor: round(e.valor) })),
    despesas: dre.despesas.map(d => ({ ...d, valor: round(d.valor) })),
    total_entrada: round(total_entrada),
    total_despesa: round(total_despesa),
    saldo: round(total_entrada - total_despesa)
  }
}
// GET /financeiro/dre?mes=2026-06[&unidade_id=xxx]  (sem unidade = consolidado de todas)
router.get('/dre', autenticar, SEM_ACESSO, TELA_DRE, async (req, res) => {
  try {
    const u = req.usuario
    const mes = req.query.mes || new Date().toISOString().slice(0,7)
    const uid = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || '')
    if (uid) {
      const dre = await montarDre(uid, mes)
      return res.json(finalizaDre(mes, uid, dre, false))
    }
    // Consolidado: soma de todas as unidades
    const { data: unidades } = await supabaseAdmin.from('unidades').select('id')
    const aggEnt = {}, aggDesp = {}; let algumSalvo = false
    for (const un of (unidades||[])) {
      const p = await montarDre(un.id, mes)
      if (p.salvo) algumSalvo = true
      p.entrada.forEach(e => {
        aggEnt[e.categoria] = aggEnt[e.categoria] || { categoria:e.categoria, auto:0, valor:0 }
        aggEnt[e.categoria].auto += e.auto || 0; aggEnt[e.categoria].valor += e.valor || 0
      })
      p.despesas.forEach(d => {
        aggDesp[d.categoria] = aggDesp[d.categoria] || { categoria:d.categoria, auto:0, valor:0, comissao:d.comissao, custom:d.custom }
        aggDesp[d.categoria].auto += d.auto || 0; aggDesp[d.categoria].valor += d.valor || 0
      })
    }
    const dre = { entrada: Object.values(aggEnt), despesas: Object.values(aggDesp), salvo: algumSalvo }
    return res.json(finalizaDre(mes, '', dre, true))
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao montar DRE' })
  }
})
// POST /financeiro/dre/salvar  { unidade_id, mes, entrada:[{categoria,valor}], despesas:[{categoria,valor}] }
router.post('/dre/salvar', autenticar, SEM_ACESSO, exigirFuncao('lancar_despesa'), async (req, res) => {
  try {
    const u = req.usuario
    const { mes, entrada = [], despesas = [] } = req.body
    const unidade_id = u.perfil === 'gerente' ? u.unidade_id : req.body.unidade_id
    if (!unidade_id || !mes) return res.status(400).json({ erro: 'unidade_id e mes são obrigatórios' })
    await supabaseAdmin.from('dre_lancamentos').delete().eq('unidade_id', unidade_id).eq('mes', mes)
    const linhas = []
    entrada.forEach((e,i) => { if (e && e.categoria) linhas.push({ unidade_id, mes, tipo:'entrada', categoria:String(e.categoria).slice(0,60), valor: parseFloat(e.valor)||0, ordem:i }) })
    despesas.forEach((d,i) => { if (d && d.categoria) linhas.push({ unidade_id, mes, tipo:'despesa', categoria:String(d.categoria).slice(0,60), valor: parseFloat(d.valor)||0, ordem:i }) })
    if (linhas.length) { const { error } = await supabaseAdmin.from('dre_lancamentos').insert(linhas); if (error) throw error }
    return res.json({ ok: true, salvos: linhas.length })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao salvar DRE' })
  }
})
// GET /financeiro/ranking-clientes?periodo=12m[&unidade_id=xxx&limit=50]
// Ranking de clientes por VALOR gasto (comandas finalizadas + AppBarber realizado).
router.get('/ranking-clientes', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const periodo = req.query.periodo || '12m'
    const uid = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || null)
    const limit = Math.min(parseInt(req.query.limit) || 50, 200)
    const agora = new Date()
    let ini
    if (periodo === 'mes')      ini = new Date(agora.getFullYear(), agora.getMonth(), 1)
    else if (periodo === 'ano') ini = new Date(agora.getFullYear(), 0, 1)
    else if (periodo === 'tudo')ini = new Date(2000, 0, 1)
    else { ini = new Date(agora); ini.setMonth(ini.getMonth() - 12) } // 12m
    const iniISO = ini.toISOString()
    const fimISO = new Date().toISOString()
    const map = {}
    const add = (cid, nome, whats, valor, quando) => {
      if (!cid) return
      if (!map[cid]) map[cid] = { cliente_id: cid, nome: nome || null, whatsapp: whats || null, total: 0, atendimentos: 0, ultima: null }
      if (nome && !map[cid].nome) map[cid].nome = nome
      if (whats && !map[cid].whatsapp) map[cid].whatsapp = whats
      map[cid].total += parseFloat(valor) || 0
      map[cid].atendimentos += 1
      if (!map[cid].ultima || quando > map[cid].ultima) map[cid].ultima = quando
    }
    // Comandas finalizadas com cliente — PAGINADO (12 meses passa MUITO de 1000)
    const cmds = await fetchAll(() => {
      let q = supabaseAdmin.from('comandas')
        .select('cliente_id, total, finalizada_em, clientes(nome, whatsapp)')
        .eq('status', 'finalizada').gte('finalizada_em', iniISO).lte('finalizada_em', fimISO)
        .not('cliente_id', 'is', null)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    for (const c of (cmds || [])) add(c.cliente_id, c.clientes?.nome, c.clientes?.whatsapp, c.total, c.finalizada_em)
    // AppBarber realizado (fora) com cliente — PAGINADO
    const abs = await fetchAll(() => {
      let q = supabaseAdmin.from('agenda_appbarber')
        .select('cliente_id, valor, inicio')
        .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
        .gte('inicio', iniISO).lte('inicio', fimISO).not('cliente_id', 'is', null)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    })
    for (const a of (abs || [])) add(a.cliente_id, null, null, a.valor, a.inicio)
    // Resolve nomes que faltaram (clientes só do AppBarber)
    const semNome = Object.values(map).filter(r => !r.nome).map(r => r.cliente_id)
    if (semNome.length) {
      // .in() em lotes: listas grandes estouram o limite da URL
      for (let i = 0; i < semNome.length; i += 300) {
        const parte = semNome.slice(i, i + 300)
        const { data: cls } = await supabaseAdmin.from('clientes').select('id, nome, whatsapp').in('id', parte)
        ;(cls || []).forEach(c => { if (map[c.id]) { map[c.id].nome = c.nome || 'Cliente'; map[c.id].whatsapp = map[c.id].whatsapp || c.whatsapp } })
      }
    }
    const ranking = Object.values(map)
      .map(r => ({ ...r, nome: r.nome || 'Cliente', total: round(r.total), ticket: r.atendimentos > 0 ? round(r.total / r.atendimentos) : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit)
    return res.json({ periodo, total_clientes: Object.keys(map).length, ranking })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao gerar ranking de clientes' })
  }
})
// GET /financeiro/frequencia-clientes?status=todos[&unidade_id=xxx]
// Calcula a cadência de cada cliente e lista os ATRASADOS/SUMIDOS (para reativação).
router.get('/frequencia-clientes', autenticar, SEM_ACESSO, async (req, res) => {
  try {
    const u = req.usuario
    const uid = u.perfil === 'gerente' ? u.unidade_id : (req.query.unidade_id || null)
    const filtro = req.query.status || 'todos'
    const agora = new Date()
    const ini = new Date(agora); ini.setMonth(ini.getMonth() - 12)
    const iniISO = ini.toISOString()
    const fimISO = agora.toISOString()
    const cmds = await fetchAll(() => {
      let q = supabaseAdmin.from('comandas').select('cliente_id, finalizada_em, clientes(nome, whatsapp)')
        .eq('status', 'finalizada').gte('finalizada_em', iniISO).lte('finalizada_em', fimISO).not('cliente_id', 'is', null)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    }, 60000)
    const abs = await fetchAll(() => {
      let q = supabaseAdmin.from('agenda_appbarber').select('cliente_id, cliente_nome, inicio')
        .eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado')
        .gte('inicio', iniISO).lte('inicio', fimISO).not('cliente_id', 'is', null)
      if (uid) q = q.eq('unidade_id', uid)
      return q
    }, 60000)
    const map = {}
    const add = (cid, nome, whats, dataISO) => {
      if (!cid || !dataISO) return
      if (!map[cid]) map[cid] = { cliente_id: cid, nome: nome || null, whatsapp: whats || null, datas: [] }
      if (nome && !map[cid].nome) map[cid].nome = nome
      if (whats && !map[cid].whatsapp) map[cid].whatsapp = whats
      map[cid].datas.push(dataISO)
    }
    cmds.forEach(c => add(c.cliente_id, c.clientes?.nome, c.clientes?.whatsapp, c.finalizada_em))
    abs.forEach(a => add(a.cliente_id, a.cliente_nome, null, a.inicio))
    const semNome = Object.values(map).filter(r => !r.nome).map(r => r.cliente_id)
    if (semNome.length) {
      for (let i = 0; i < semNome.length; i += 300) {
        const parte = semNome.slice(i, i + 300)
        const { data: cls } = await supabaseAdmin.from('clientes').select('id, nome, whatsapp').in('id', parte)
        ;(cls || []).forEach(c => { if (map[c.id]) { map[c.id].nome = c.nome || 'Cliente'; map[c.id].whatsapp = map[c.id].whatsapp || c.whatsapp } })
      }
    }
    const diaMs = 86400000
    const lista = []
    Object.values(map).forEach(r => {
      const datas = r.datas.map(d => new Date(d)).sort((a, b) => a - b)
      const visitas = datas.length
      const ultima = datas[visitas - 1]
      const diasDesde = Math.floor((agora - ultima) / diaMs)
      let cadencia = null, status = 'em_dia'
      if (visitas >= 2) {
        let soma = 0
        for (let i = 1; i < visitas; i++) soma += (datas[i] - datas[i - 1]) / diaMs
        cadencia = Math.max(1, Math.round(soma / (visitas - 1)))
        if (diasDesde >= cadencia * 2) status = 'sumido'
        else if (diasDesde >= cadencia) status = 'atrasado'
      } else {
        if (diasDesde > 45) status = 'sumido'
      }
      lista.push({
        nome: r.nome || 'Cliente', whatsapp: r.whatsapp || null,
        visitas, cadencia, ultima: ultima.toISOString(), dias_desde: diasDesde, status
      })
    })
    let resultado = lista.filter(c => c.status === 'atrasado' || c.status === 'sumido')
    if (filtro === 'atrasado') resultado = resultado.filter(c => c.status === 'atrasado')
    else if (filtro === 'sumido') resultado = resultado.filter(c => c.status === 'sumido')
    resultado.sort((a, b) => b.dias_desde - a.dias_desde)
    return res.json({ total: resultado.length, clientes: resultado.slice(0, 200) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao calcular frequência' })
  }
})
module.exports = router
