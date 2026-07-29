const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')
const ADMIN = exigirPerfil('proprietario', 'gerente')
const { exigirTela, exigirFuncao } = require('./permissoes')
const TELA_ESTOQUE = exigirTela('estoque')
// resolve o "base" de um perfil (perfis novos herdam de um fixo)
const PERFIS_FIXOS_CAD = ['proprietario','gerente','caixa','colaborador','funcionario','cliente']
async function baseDoPerfilCad(perfil) {
  if (!perfil || PERFIS_FIXOS_CAD.includes(perfil)) return perfil
  try {
    const { data } = await supabaseAdmin.from('perfis_acesso').select('base').eq('chave', perfil).maybeSingle()
    return (data && data.base) || 'colaborador'
  } catch (e) { return 'colaborador' }
}
// ============ UNIDADES ============
router.get('/unidades', autenticar, async (req, res) => {
  try {
    const u = req.usuario
    let query = supabaseAdmin.from('unidades').select('*, horarios_unidade(*)').eq('ativa', true).order('nome')
    // Caixa enxerga TODAS as unidades (pode agendar/editar em qualquer uma).
    // Apenas o barbeiro (colaborador) fica restrito à própria unidade.
    if (u.perfil === 'colaborador') {
      query = query.eq('id', u.unidade_id)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar unidades' })
  }
})
router.post('/unidades', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { nome, endereco, bairro, cidade, cep, telefone, email, horarios } = req.body
    const { data: unidade, error } = await supabaseAdmin
      .from('unidades').insert({ nome, endereco, bairro, cidade, cep, telefone, email }).select().single()
    if (error) throw error
    if (horarios && Array.isArray(horarios)) {
      const rows = horarios.map(h => ({ ...h, unidade_id: unidade.id }))
      await supabaseAdmin.from('horarios_unidade').insert(rows)
    }
    return res.status(201).json(unidade)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar unidade' })
  }
})
router.put('/unidades/:id', autenticar, exigirPerfil('proprietario', 'gerente'), async (req, res) => {
  try {
    // Gerente só edita a própria unidade
    if (req.usuario.perfil === 'gerente' && String(req.params.id) !== String(req.usuario.unidade_id)) {
      return res.status(403).json({ erro: 'Você só pode editar a sua unidade' })
    }
    const { horarios, ...campos } = req.body
    const { data, error } = await supabaseAdmin.from('unidades').update(campos).eq('id', req.params.id).select().single()
    if (error) throw error
    if (horarios && Array.isArray(horarios)) {
      await supabaseAdmin.from('horarios_unidade').delete().eq('unidade_id', req.params.id)
      const rows = horarios.map(h => ({ ...h, unidade_id: req.params.id }))
      await supabaseAdmin.from('horarios_unidade').insert(rows)
    }
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar unidade' })
  }
})
// ============ COLABORADORES ============
// Nome de exibição do barbeiro: sobrenome só quando o toggle 'mostrar_sobrenome'
// está ligado no cadastro. Padrão = só o primeiro nome. Fonte única desta regra.
function nomeExibicao(c){
  if(!c) return ''
  return c.mostrar_sobrenome ? String(c.nome || '') : String(c.nome || '').split(' ')[0]
}

router.get('/colaboradores', autenticar, async (req, res) => {
  try {
    const { unidade_id } = req.query
    const u = req.usuario
    let query = supabaseAdmin
      .from('colaboradores')
      .select('id, nome, email, whatsapp, perfil, comissao_pct, salario, ativo, foto_url, unidade_id, mostrar_sobrenome, unidades(nome)')
      .eq('ativo', true)
      .in('perfil', ['colaborador','gerente'])   // só quem ATENDE (nunca o caixa)
      .order('nome')
    // Caixa e proprietário enxergam colaboradores de qualquer unidade (p/ agendar em todas).
    // Gerente e barbeiro ficam restritos à própria unidade.
    if (u.perfil === 'proprietario' || u.perfil === 'caixa') {
      if (unidade_id) query = query.eq('unidade_id', unidade_id)
    } else {
      query = query.eq('unidade_id', u.unidade_id)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json((data || []).map(c => ({ ...c, nome_exibicao: nomeExibicao(c) })))
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar colaboradores' })
  }
})
router.post('/colaboradores', autenticar, exigirPerfil('proprietario', 'gerente'), exigirFuncao('gerir_colaborador'), async (req, res) => {
  try {
    const { nome, email, whatsapp, cpf, data_nasc, perfil, unidade_id, comissao_pct, salario, servico_ids, senha_temp, foto_url, foto_url_2, mostrar_sobrenome } = req.body
    // Gerente: força a própria unidade e não pode criar proprietário
    let unidadeFinal = unidade_id
    let perfilFinal = perfil
    if (req.usuario.perfil === 'gerente') {
      unidadeFinal = req.usuario.unidade_id
      if (perfilFinal === 'proprietario') perfilFinal = 'colaborador'
    }
    const ehFuncionario = (perfilFinal === 'funcionario') || (await baseDoPerfilCad(perfilFinal) === 'funcionario')
    // Funcionário não comissionado NÃO tem login (sem user no Auth).
    let userId = null
    if (!ehFuncionario) {
      const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email, password: senha_temp || 'Barber1989!', email_confirm: true
      })
      if (authErr) throw authErr
      userId = authData.user.id
    }
    const registro = {
      user_id: userId, nome, whatsapp, cpf, data_nasc,
      perfil: perfilFinal, unidade_id: unidadeFinal, foto_url, foto_url_2,
      comissao_pct: ehFuncionario ? 0 : comissao_pct,
      mostrar_sobrenome: !!mostrar_sobrenome,
    }
    if (email) registro.email = email
    if (ehFuncionario) registro.salario = parseFloat(salario) || 0
    const { data: colab, error } = await supabaseAdmin
      .from('colaboradores')
      .insert(registro)
      .select().single()
    if (error) throw error
    // Vínculos com serviços
    if (servico_ids?.length) {
      const rows = servico_ids.map(s => ({ colaborador_id: colab.id, servico_id: s }))
      await supabaseAdmin.from('colaborador_servicos').insert(rows)
    }
    return res.status(201).json(colab)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ erro: 'Erro ao criar colaborador' })
  }
})
router.put('/colaboradores/:id', autenticar, exigirPerfil('proprietario', 'gerente'), exigirFuncao('gerir_colaborador'), async (req, res) => {
  try {
    const { servico_ids, senha_temp, ...campos } = req.body
    // Gerente: só edita colaborador da própria unidade, não muda de unidade nem vira proprietário
    if (req.usuario.perfil === 'gerente') {
      const { data: alvo } = await supabaseAdmin.from('colaboradores').select('unidade_id').eq('id', req.params.id).single()
      if (!alvo || alvo.unidade_id !== req.usuario.unidade_id) {
        return res.status(403).json({ erro: 'Você só pode editar colaboradores da sua unidade' })
      }
      if (campos.unidade_id) campos.unidade_id = req.usuario.unidade_id
      if (campos.perfil === 'proprietario') delete campos.perfil
    }
    const { data, error } = await supabaseAdmin.from('colaboradores').update(campos).eq('id', req.params.id).select().single()
    if (error) throw error
    if (servico_ids) {
      await supabaseAdmin.from('colaborador_servicos').delete().eq('colaborador_id', req.params.id)
      if (servico_ids.length) {
        const rows = servico_ids.map(s => ({ colaborador_id: req.params.id, servico_id: s }))
        await supabaseAdmin.from('colaborador_servicos').insert(rows)
      }
    }
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar colaborador' })
  }
})

// POST /colaboradores/:id/transferir — troca SÓ a unidade do barbeiro.
// Autonomia total (A1): proprietário ou gerente, qualquer barbeiro pra qualquer unidade.
// Ação dedicada de propósito: não abre edição de salário/comissão entre unidades.
// POST /colaboradores/:id/redefinir-acesso — corrige o email de LOGIN e/ou define a senha
// do colaborador (opera no usuário de Auth via admin, que gera o hash correto da senha).
// A senha é digitada pelo gestor na tela; nunca fica no código.
router.post('/colaboradores/:id/redefinir-acesso', autenticar, exigirPerfil('proprietario', 'gerente'), exigirFuncao('gerir_colaborador'), async (req, res) => {
  try {
    const { email, senha } = req.body
    if (!email && !senha) return res.status(400).json({ erro: 'Informe o novo email e/ou a nova senha' })
    const { data: colab } = await supabaseAdmin.from('colaboradores').select('id, user_id, nome').eq('id', req.params.id).single()
    if (!colab) return res.status(404).json({ erro: 'Colaborador não encontrado' })
    if (!colab.user_id) return res.status(400).json({ erro: 'Este colaborador não tem usuário de login (ex.: funcionário sem acesso ao sistema).' })
    const patch = { email_confirm: true }
    if (email) patch.email = String(email).trim()
    if (senha) patch.password = String(senha)
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(colab.user_id, patch)
    if (authErr) throw authErr
    if (email) await supabaseAdmin.from('colaboradores').update({ email: String(email).trim() }).eq('id', req.params.id)
    return res.json({ ok: true })
  } catch (e) {
    console.error('[redefinir-acesso]', e.message)
    return res.status(500).json({ erro: e.message || 'Erro ao redefinir acesso' })
  }
})

router.post('/colaboradores/:id/transferir', autenticar, exigirPerfil('proprietario', 'gerente'), exigirFuncao('gerir_colaborador'), async (req, res) => {
  try {
    const { nova_unidade_id } = req.body
    if (!nova_unidade_id) return res.status(400).json({ erro: 'nova_unidade_id é obrigatório' })
    const { data: alvo } = await supabaseAdmin.from('colaboradores').select('id, nome, unidade_id').eq('id', req.params.id).single()
    if (!alvo) return res.status(404).json({ erro: 'Colaborador não encontrado' })
    if (String(alvo.unidade_id) === String(nova_unidade_id)) return res.status(400).json({ erro: 'O barbeiro já está nessa unidade' })
    const { data, error } = await supabaseAdmin.from('colaboradores')
      .update({ unidade_id: nova_unidade_id }).eq('id', req.params.id)
      .select('id, nome, unidade_id, unidades(nome)').single()
    if (error) throw error
    console.log(`[transferencia] ${req.usuario.nome} transferiu ${alvo.nome} de ${alvo.unidade_id} -> ${nova_unidade_id}`)
    return res.json(data)
  } catch (e) {
    console.error('[colaboradores/transferir]', e.message)
    return res.status(500).json({ erro: 'Erro ao transferir colaborador' })
  }
})
// ============ CLIENTES ============
router.get('/clientes', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { busca, q, unidade_id } = req.query
    const termo = String(busca || q || '').trim()
    const lim = Math.min(parseInt(req.query.limit, 10) || 100, 100)
    let query = supabaseAdmin
      .from('clientes')
      .select('id, nome, email, whatsapp, cpf, ativo, criado_em, colaborador_pref, unidade_pref')
      .order('nome').limit(lim)
    if (termo) {
      // Buscando por nome/telefone/cpf -> acha TODOS (inclusive inativos),
      // pra o operador nunca precisar recriar um cadastro que já existe.
      query = query.or(`nome.ilike.%${termo}%,whatsapp.ilike.%${termo}%,cpf.ilike.%${termo}%`)
    } else {
      // Lista padrão (sem digitar nada) -> só ativos, pra não poluir.
      query = query.eq('ativo', true)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar clientes' })
  }
})
router.get('/clientes/meu', autenticar, exigirPerfil('cliente'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('clientes')
      .select('*, unidades(nome), colaboradores(nome)')
      .eq('user_id', req.usuario.user_id).single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar dados do cliente' })
  }
})
// GET /clientes/:id/plano — assinatura ativa de um cliente (para o atendimento/comanda)
router.get('/clientes/:id/plano', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    const cliente_id = req.params.id
    const { data: assin } = await supabaseAdmin.from('assinaturas')
      .select('*, planos(id,nome,valor_mensal)').eq('cliente_id', cliente_id)
      .eq('status', 'ativa').limit(1)
    if (!assin || !assin.length) return res.json({ ativo: false })
    const a = assin[0]
    const plano = a.planos || {}
    const { data: ps } = await supabaseAdmin.from('plano_servicos')
      .select('servico_id, limite_mes, servicos(nome)').eq('plano_id', plano.id)
    const agora = new Date()
    const ini = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
    const { data: usados } = await supabaseAdmin.from('agendamentos')
      .select('servico_id').eq('cliente_id', cliente_id)
      .eq('status', 'concluido').gte('data_hora_ini', ini)
    const cont = {}
    ;(usados || []).forEach(u => { cont[u.servico_id] = (cont[u.servico_id] || 0) + 1 })
    const servicos = (ps || []).map(x => ({
      nome: (x.servicos && x.servicos.nome) || 'Serviço',
      limite_mes: x.limite_mes,
      usado: cont[x.servico_id] || 0
    }))
    return res.json({
      ativo: true,
      plano: { nome: plano.nome, valor_mensal: plano.valor_mensal },
      credito_saldo: a.credito_saldo != null ? a.credito_saldo : null,
      data_renovacao: a.data_renovacao || null,
      servicos
    })
  } catch (e) {
    console.error('[clientes/plano]', e.message)
    return res.status(500).json({ erro: 'Erro ao carregar plano do cliente' })
  }
})

// GET /clientes/:id/historico — últimas visitas do cliente (todos os perfis do PRO).
// Colunas: data/hora, unidade, barbeiro, serviço, total da comanda ligada.
// GET /clientes/contato-por-nome?nome=X — acha o WhatsApp de um cliente pelo nome, mas
// SÓ quando o match é ÚNICO (0 ou vários = não arrisca abrir a pessoa errada).
// Fallback pra agendamento sem cliente_id nem número salvo. Todos os perfis do PRO.
router.get('/clientes/contato-por-nome', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    const nome = String(req.query.nome || '').trim()
    if (!nome) return res.json({ whatsapp: null })
    const { data } = await supabaseAdmin.from('clientes')
      .select('nome, whatsapp').ilike('nome', nome).limit(5)
    const comZap = (data || []).filter(c => c.whatsapp)
    if (comZap.length === 1) return res.json({ nome: comZap[0].nome, whatsapp: comZap[0].whatsapp })
    return res.json({ whatsapp: null, ambiguo: comZap.length > 1 })
  } catch (e) {
    console.error('[clientes/contato-por-nome]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar contato' })
  }
})

// GET /clientes/:id/contato — nome + WhatsApp do cliente (p/ o barbeiro falar sobre o
// agendamento pelo WhatsApp do próprio celular). Todos os perfis do PRO.
router.get('/clientes/:id/contato', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from('clientes').select('nome, whatsapp').eq('id', req.params.id).single()
    if (!data) return res.status(404).json({ erro: 'Cliente não encontrado' })
    return res.json({ nome: data.nome || null, whatsapp: data.whatsapp || null })
  } catch (e) {
    console.error('[clientes/contato]', e.message)
    return res.status(500).json({ erro: 'Erro ao buscar contato do cliente' })
  }
})

router.get('/clientes/:id/historico', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    const clienteId = req.params.id
    const limite = Math.min(parseInt(req.query.limite) || 20, 50)
    const { data: ags, error } = await supabaseAdmin.from('agendamentos')
      .select('id, data_hora_ini, servicos(nome), colaboradores!colaborador_id(nome), unidades(nome)')
      .eq('cliente_id', clienteId)
      .eq('status', 'concluido')
      .order('data_hora_ini', { ascending: false })
      .limit(limite)
    if (error) throw error
    const agIds = (ags || []).map(a => a.id)
    let totalPorAg = {}
    if (agIds.length) {
      const { data: cmds } = await supabaseAdmin.from('comandas')
        .select('agendamento_id, total').in('agendamento_id', agIds)
      ;(cmds || []).forEach(c => { if (c.agendamento_id != null) totalPorAg[c.agendamento_id] = c.total })
    }
    const visitas = (ags || []).map(a => ({
      data_hora: a.data_hora_ini,
      unidade:   a.unidades ? a.unidades.nome : null,
      barbeiro:  a.colaboradores ? a.colaboradores.nome : null,
      servico:   a.servicos ? a.servicos.nome : null,
      total:     totalPorAg[a.id] != null ? totalPorAg[a.id] : null
    }))
    return res.json(visitas)
  } catch (e) {
    console.error('[clientes/historico]', e.message)
    return res.status(500).json({ erro: 'Erro ao carregar histórico do cliente' })
  }
})
router.put('/clientes/:id', autenticar, async (req, res) => {
  try {
    const u = req.usuario
    // Cliente só pode editar a si mesmo
    if (u.perfil === 'cliente') {
      const { data: cli } = await supabaseAdmin.from('clientes').select('id').eq('user_id', u.user_id).single()
      if (!cli || cli.id !== req.params.id) return res.status(403).json({ erro: 'Sem permissão' })
    }
    const { data, error } = await supabaseAdmin
      .from('clientes').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar cliente' })
  }
})
// GET /clientes/:id/situacao-plano — situação completa p/ a comanda (coroa, zerar, renovar)
router.get('/clientes/:id/situacao-plano', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    const cliente_id = req.params.id
    // assinatura mais recente do cliente (qualquer status)
    const { data: assins } = await supabaseAdmin.from('assinaturas')
      .select('*, planos(id,nome,valor_mensal,visitas_semana,fichas_bar_mes), colaboradores!vendedor_id(id,nome)')
      .eq('cliente_id', cliente_id)
      .order('data_renovacao', { ascending: false }).limit(1)
    if (!assins || !assins.length) return res.json({ assinante: false })
    const a = assins[0]
    const plano = a.planos || {}
    // serviços cobertos pelo plano
    const { data: ps } = await supabaseAdmin.from('plano_servicos')
      .select('servico_id, servicos(nome)').eq('plano_id', plano.id)
    const servicos_cobertos = (ps || []).map(x => x.servico_id)
    const servicos_nomes = (ps || []).map(x => (x.servicos && x.servicos.nome) || '').filter(Boolean)
    // limites da semana (segunda 00:00 → próxima segunda) em horário de São Paulo (-03:00)
    const sp = new Date(Date.now() - 3 * 3600 * 1000)
    const dow = sp.getUTCDay()                       // 0=dom .. 6=sáb
    const diffMon = (dow === 0 ? 6 : dow - 1)
    const monMid = Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate() - diffMon, 0, 0, 0)
    const ini = new Date(monMid + 3 * 3600 * 1000).toISOString()
    const fim = new Date(monMid + 3 * 3600 * 1000 + 7 * 24 * 3600 * 1000).toISOString()
    // visitas do plano já usadas nesta semana (itens marcados como 'plano')
    let visitas_usadas = 0
    try {
      const { data: usados } = await supabaseAdmin.from('itens_comanda')
        .select('id, comandas!inner(cliente_id,status,finalizada_em)')
        .eq('comandas.cliente_id', cliente_id)
        .eq('comandas.status', 'finalizada')
        .gte('comandas.finalizada_em', ini).lt('comandas.finalizada_em', fim)
        .ilike('tipo', '%plano%')
      visitas_usadas = (usados || []).length
    } catch (e) { visitas_usadas = 0 }
    const visitas_semana = plano.visitas_semana || 1
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
    const venceu = a.data_renovacao && String(a.data_renovacao).slice(0, 10) < hoje
    const em_dia = (a.status === 'ativa') && !venceu
    const pode_zerar = em_dia && (visitas_usadas < visitas_semana)
    // ITEM 7: fichas ACUMULAM e expiram em 90 dias (tabela fichas_plano).
    // Disponíveis = soma dos lotes válidos (não expirados) ainda com saldo.
    let fichas_disponiveis = 0
    try {
      const { data: fd } = await supabaseAdmin.rpc('fichas_disponiveis_cliente', { p_cliente: cliente_id })
      fichas_disponiveis = parseInt(fd) || 0
    } catch (e) { fichas_disponiveis = 0 }
    const fichas_total = plano.fichas_bar_mes || 0
    // Plano vencido/inativo não dá direito a usar fichas no momento.
    if (!em_dia) fichas_disponiveis = 0
    const fichas_usadas = 0  // (compat: o saldo já vem líquido da tabela)
    return res.json({
      assinante: true,
      assinatura_id: a.id,
      situacao: em_dia ? 'em_dia' : 'atrasado',
      status_assinatura: a.status,
      plano: { id: plano.id, nome: plano.nome, valor_mensal: plano.valor_mensal },
      servicos_cobertos,
      servicos_nomes,
      visitas_semana,
      visitas_usadas,
      fichas_bar_mes: fichas_total,
      fichas_usadas: fichas_usadas,
      fichas_disponiveis: fichas_disponiveis,
      barbeiro_titular: (a.colaboradores && a.colaboradores.nome) || null,
      pode_zerar,
      data_renovacao: a.data_renovacao || null
    })
  } catch (e) {
    console.error('[situacao-plano]', e.message)
    return res.status(500).json({ erro: 'Erro ao carregar situação do plano' })
  }
})
// GET /clientes-assinantes-ids — ids E nomes dos clientes assinantes (p/ a coroa na agenda)
// Retorna também quem está VENCIDO/SUSPENSO (p/ a bolinha vermelha ao lado da coroa).
router.get('/clientes-assinantes-ids', autenticar, exigirPerfil('proprietario','gerente','caixa','colaborador'), async (req, res) => {
  try {
    // CORREÇÃO: "vencido" tem que olhar a DATA de renovação, não só o campo status.
    // O status não vira 'vencida' sozinho quando a data passa, então assinaturas
    // com status='ativa' e data_renovacao no passado apareciam como em dia (coroa
    // sem a bolinha vermelha). Agora usa o mesmo critério da comanda (situacao-plano).
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
    const { data } = await supabaseAdmin.from('assinaturas')
      .select('cliente_id, status, data_renovacao, clientes(nome)').in('status', ['ativa','vencida','suspensa'])
    const linhas = data || []
    // Em dia = status 'ativa' E ainda não passou da data de renovação.
    // Sem data cadastrada: não marca como vencido (evita bolinha vermelha errada).
    function estaEmDia(a) {
      if (a.status !== 'ativa') return false
      if (!a.data_renovacao) return true
      return String(a.data_renovacao).slice(0, 10) >= hoje
    }
    const ids = Array.from(new Set(linhas.map(a => a.cliente_id).filter(Boolean)))
    const nomes = Array.from(new Set(linhas.map(a => a.clientes && a.clientes.nome).filter(Boolean)))
    // Um cliente pode ter mais de uma linha; se ao menos uma estiver EM DIA, ele não é vencido.
    const emDiaSet = new Set(linhas.filter(estaEmDia).map(a => a.cliente_id))
    const vencidos = linhas.filter(a => !estaEmDia(a) && !emDiaSet.has(a.cliente_id))
    const ids_vencidos = Array.from(new Set(vencidos.map(a => a.cliente_id).filter(Boolean)))
    const nomes_vencidos = Array.from(new Set(vencidos.map(a => a.clientes && a.clientes.nome).filter(Boolean)))
    return res.json({ ids, nomes, ids_vencidos, nomes_vencidos })
  } catch (e) { return res.json({ ids: [], nomes: [], ids_vencidos: [], nomes_vencidos: [] }) }
})
// ============ SERVIÇOS ============
router.get('/servicos', autenticar, async (req, res) => {
  try {
    const { colaborador_id } = req.query
    let query = supabaseAdmin.from('servicos').select('*').eq('ativo', true).order('nome')
    if (colaborador_id) {
      const { data: vinculos } = await supabaseAdmin
        .from('colaborador_servicos').select('servico_id').eq('colaborador_id', colaborador_id)
      const ids = (vinculos || []).map(v => v.servico_id)
      if (ids.length) query = query.in('id', ids)
    }
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar serviços' })
  }
})
router.post('/servicos', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('servicos').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar serviço' })
  }
})
router.put('/servicos/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('servicos').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar serviço' })
  }
})
// ============ PRODUTOS ============
router.get('/produtos', autenticar, async (req, res) => {
  try {
    const { categoria_id } = req.query
    let query = supabaseAdmin.from('produtos').select('*, categorias_produto(nome, paga_comissao)').eq('ativo', true).order('nome')
    if (categoria_id) query = query.eq('categoria_id', categoria_id)
    const { data, error } = await query
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar produtos' })
  }
})
router.get('/produtos/por-barcode/:barcode', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('produtos').select('*').eq('barcode', req.params.barcode).single()
    if (error || !data) return res.status(404).json({ erro: 'Produto não encontrado' })
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar produto' })
  }
})
router.post('/produtos', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('produtos').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar produto' })
  }
})
router.put('/produtos/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('produtos').update(req.body).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar produto' })
  }
})
// ============ ESTOQUE ============
router.post('/estoque/entrada', autenticar, ADMIN, async (req, res) => {
  try {
    const { produto_id, quantidade, valor_unitario, observacao } = req.body
    // Proprietário escolhe a unidade; gerente só pode lançar na PRÓPRIA unidade.
    const unidade_id = req.usuario.perfil === 'proprietario' ? req.body.unidade_id : req.usuario.unidade_id
    if (!produto_id || !unidade_id) return res.status(400).json({ erro: 'Produto e unidade são obrigatórios' })
    const { data, error } = await supabaseAdmin
      .from('movimentacoes_estoque')
      .insert({ produto_id, unidade_id, tipo: 'entrada', quantidade, valor_unitario, responsavel_id: req.usuario.id, observacao })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao registrar entrada' })
  }
})
// Lê todos os movimentos de uma unidade (paginado: passa do limite de 1000).
async function _movimentosUnidade(unidade_id, produto_id) {
  const pageSize = 1000; let from = 0; let all = []
  while (true) {
    let q = supabaseAdmin.from('movimentacoes_estoque')
      .select('produto_id, tipo, quantidade').eq('unidade_id', unidade_id)
    if (produto_id) q = q.eq('produto_id', produto_id)
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
    if (from > 200000) break
  }
  return all
}
// saldo = entradas + ajustes (assinados) - saídas
function _saldoPorProduto(movs) {
  const s = {}
  for (const m of movs) {
    const q = parseFloat(m.quantidade) || 0
    const neg = String(m.tipo || '').startsWith('saida')
    s[m.produto_id] = (s[m.produto_id] || 0) + (neg ? -q : q)
  }
  return s
}
// GET /estoque/saldo?unidade_id=xxx — saldo atual de cada produto ativo na unidade
router.get('/estoque/saldo', autenticar, exigirPerfil('proprietario','gerente','caixa'), TELA_ESTOQUE, async (req, res) => {
  try {
    const unidade_id = req.usuario.perfil === 'proprietario' ? (req.query.unidade_id || null) : req.usuario.unidade_id
    if (!unidade_id) return res.status(400).json({ erro: 'Informe a unidade' })
    const { data: prods } = await supabaseAdmin.from('produtos')
      .select('id, nome, valor_venda, estoque_minimo, categorias_produto(nome)')
      .eq('ativo', true).order('nome')
    const saldo = _saldoPorProduto(await _movimentosUnidade(unidade_id, null))
    const lista = (prods || []).map(p => ({
      produto_id: p.id, nome: p.nome,
      categoria: (p.categorias_produto && p.categorias_produto.nome) || '—',
      valor_venda: p.valor_venda, estoque_minimo: p.estoque_minimo || 0,
      saldo: Math.round(saldo[p.id] || 0)
    }))
    return res.json({
      unidade_id,
      pode_escolher: req.usuario.perfil === 'proprietario',
      produtos: lista
    })
  } catch (err) {
    console.error('[estoque/saldo]', err.message)
    return res.status(500).json({ erro: 'Erro ao buscar saldo de estoque' })
  }
})
// POST /estoque/acerto — digita a CONTAGEM real e o sistema ajusta o saldo (só Proprietário)
router.post('/estoque/acerto', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { produto_id, unidade_id, contagem } = req.body
    if (!produto_id || !unidade_id || contagem == null || isNaN(parseFloat(contagem)))
      return res.status(400).json({ erro: 'Envie produto_id, unidade_id e contagem' })
    const saldoMap = _saldoPorProduto(await _movimentosUnidade(unidade_id, produto_id))
    const saldoAtual = Math.round(saldoMap[produto_id] || 0)
    const alvo = Math.round(parseFloat(contagem))
    const diff = alvo - saldoAtual
    if (diff !== 0) {
      const { error } = await supabaseAdmin.from('movimentacoes_estoque').insert({
        produto_id, unidade_id, tipo: 'ajuste', quantidade: diff,
        responsavel_id: req.usuario.id,
        observacao: 'Acerto de contagem (de ' + saldoAtual + ' para ' + alvo + ')'
      })
      if (error) throw error
    }
    return res.json({ ok: true, saldo_anterior: saldoAtual, saldo_novo: alvo, ajuste: diff })
  } catch (err) {
    console.error('[estoque/acerto]', err.message)
    return res.status(500).json({ erro: 'Erro ao registrar acerto' })
  }
})
// ============ PLANOS ============
router.get('/planos', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('planos')
      .select('*, plano_servicos(servico_id, limite_mes, servicos(nome, duracao_min))')
      .eq('ativo', true).order('valor_mensal')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar planos' })
  }
})
router.post('/planos', autenticar, exigirPerfil('proprietario'), async (req, res) => {
  try {
    const { servico_ids, ...plano } = req.body
    const { data, error } = await supabaseAdmin.from('planos').insert(plano).select().single()
    if (error) throw error
    if (servico_ids?.length) {
      const rows = servico_ids.map(s => ({ plano_id: data.id, servico_id: s.id, limite_mes: s.limite || null }))
      await supabaseAdmin.from('plano_servicos').insert(rows)
    }
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar plano' })
  }
})
router.get('/assinaturas', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('assinaturas')
      .select('*, clientes(id, nome, whatsapp, email, unidade_pref), planos(id, nome, valor_mensal), colaboradores!vendedor_id(id, nome)')
      .order('data_renovacao')
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar assinaturas' })
  }
})
// PATCH /assinaturas/:id — edita campos da assinatura (plano, status, datas, titular)
router.patch('/assinaturas/:id', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    // ITEM 7 (corrigido): caixa, gerente e proprietário editam TODOS os campos.
    // Antes o caixa só podia trocar o barbeiro titular e o resto (inclusive a
    // data de renovação) era descartado silenciosamente — parecia que salvava.
    const permitidos = ['plano_id','status','data_inicio','data_renovacao','vendedor_id','vendedor_id_2','valor_split_1','forma_pgto']
    const campos = {}
    for (const k of permitidos) if (k in req.body) campos[k] = (req.body[k] === '' ? null : req.body[k])
    if (Object.keys(campos).length === 0) {
      return res.status(400).json({ erro: 'Nada para atualizar' })
    }
    campos.atualizado_em = new Date().toISOString()
    const { data, error } = await supabaseAdmin
      .from('assinaturas').update(campos).eq('id', req.params.id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao atualizar assinatura' })
  }
})
// DELETE /assinaturas/:id — remove uma assinatura
router.delete('/assinaturas/:id', autenticar, exigirPerfil('proprietario','gerente','caixa'), async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('assinaturas').delete().eq('id', req.params.id)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao remover assinatura' })
  }
})
router.post('/assinaturas', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('assinaturas').insert(req.body).select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao criar assinatura' })
  }
})
// ============================================================
// POST /assinaturas/cobrar — VENDE/ATIVA ou RENOVA um plano.
//   - cria/renova a assinatura (vendedor_id = barbeiro responsável)
//   - lança a MENSALIDADE como comanda FINALIZADA (item tipo='plano'
//     = valor_mensal no nome do vendedor): entra no faturamento e
//     gera comissão, mas NÃO conta como atendimento.
//   - renovação soma 1 mês a partir do vencimento atual (se ainda
//     ativo) ou de hoje (se já vencido).
//   - se a comanda falhar, desfaz a alteração na assinatura (rollback).
// ============================================================
router.post('/assinaturas/cobrar', autenticar, exigirPerfil('proprietario', 'gerente', 'caixa'), exigirFuncao('vender_plano'), async (req, res) => {
  try {
    const { cliente_id, plano_id, vendedor_id, forma_pgto, assinatura_id } = req.body
    // data de vencimento escolhida manualmente (opcional). Se vier, usa ela;
    // senão, calcula automático (+1 mês). Aceita 'YYYY-MM-DD'.
    const dataVencManual = (req.body.data_renovacao && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.data_renovacao)))
      ? String(req.body.data_renovacao).slice(0, 10) : null
    if (!cliente_id) return res.status(400).json({ erro: 'Informe o cliente.' })
    if (!plano_id) return res.status(400).json({ erro: 'Informe o plano.' })
    if (!vendedor_id) return res.status(400).json({ erro: 'Informe o barbeiro responsável da mensalidade.' })
    if (!forma_pgto) return res.status(400).json({ erro: 'Informe a forma de pagamento.' })
    const { data: plano } = await supabaseAdmin.from('planos').select('id, nome, valor_mensal, fichas_bar_mes').eq('id', plano_id).single()
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado.' })
    const valor = parseFloat(plano.valor_mensal) || 0
    // Divisão do plano entre 2 barbeiros (opcional). vendedor_id = barbeiro 1;
    // vendedor_id_2 = barbeiro 2; valor_split_1 = R$ do barbeiro 1 (o 2 recebe o resto).
    // As duas partes somam SEMPRE o valor cheio → faturamento não muda; só a comissão racha.
    // A request pode mandar; se for RENOVAÇÃO e não mandar, herda o que está salvo (persistido).
    let reqV2 = req.body.vendedor_id_2, reqSplit1 = req.body.valor_split_1
    if (assinatura_id && reqV2 === undefined && reqSplit1 === undefined) {
      const { data: prevA } = await supabaseAdmin.from('assinaturas').select('vendedor_id_2, valor_split_1').eq('id', assinatura_id).single()
      if (prevA) { reqV2 = prevA.vendedor_id_2; reqSplit1 = prevA.valor_split_1 }
    }
    const vendedor_id_2 = (reqV2 && reqV2 !== vendedor_id) ? reqV2 : null
    let valSplit1 = null, valSplit2 = null
    if (vendedor_id_2) {
      let v1 = parseFloat(reqSplit1)
      if (!(v1 >= 0)) v1 = Math.round((valor / 2) * 100) / 100          // default: metade
      v1 = Math.min(valor, Math.max(0, Math.round(v1 * 100) / 100))
      valSplit1 = v1
      valSplit2 = Math.round((valor - v1) * 100) / 100
    }
    const { data: cli } = await supabaseAdmin.from('clientes').select('id, unidade_pref').eq('id', cliente_id).single()
    const unidade_id = req.usuario.unidade_id || req.body.unidade_id || (cli && cli.unidade_pref) || null
    if (!unidade_id) return res.status(400).json({ erro: 'Não consegui identificar a unidade. Selecione a unidade.' })
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10)
    function maisUmMes(baseYMD) {
      const d = new Date(baseYMD + 'T12:00:00-03:00')
      d.setMonth(d.getMonth() + 1)
      return d.toISOString().slice(0, 10)
    }
    // ===== assinatura: renovar OU criar =====
    let assinatura, criouNova = false, antes = null
    if (assinatura_id) {
      const { data: atual } = await supabaseAdmin.from('assinaturas').select('*').eq('id', assinatura_id).single()
      if (!atual) return res.status(404).json({ erro: 'Assinatura não encontrada.' })
      antes = { data_renovacao: atual.data_renovacao, status: atual.status, vendedor_id: atual.vendedor_id, vendedor_id_2: atual.vendedor_id_2, valor_split_1: atual.valor_split_1, forma_pgto: atual.forma_pgto, plano_id: atual.plano_id }
      const venceAtivo = atual.data_renovacao && String(atual.data_renovacao).slice(0, 10) >= hoje
      const base = venceAtivo ? String(atual.data_renovacao).slice(0, 10) : hoje
      const novaData = dataVencManual || maisUmMes(base)   // manual tem prioridade
      const { data: upd, error: eU } = await supabaseAdmin.from('assinaturas').update({
        plano_id, status: 'ativa', data_renovacao: novaData,
        vendedor_id, vendedor_id_2, valor_split_1: valSplit1,
        forma_pgto, atualizado_em: new Date().toISOString()
      }).eq('id', assinatura_id).select().single()
      if (eU) throw eU
      assinatura = upd
    } else {
      const { data: jaTem } = await supabaseAdmin.from('assinaturas')
        .select('id').eq('cliente_id', cliente_id).eq('status', 'ativa').limit(1)
      if (jaTem && jaTem.length) {
        return res.status(409).json({ erro: 'Este cliente já tem uma assinatura ativa. Use a opção Renovar.' })
      }
      const { data: nova, error: eN } = await supabaseAdmin.from('assinaturas').insert({
        cliente_id, plano_id, status: 'ativa',
        data_inicio: hoje, data_renovacao: dataVencManual || maisUmMes(hoje),
        vendedor_id, vendedor_id_2, valor_split_1: valSplit1, forma_pgto
      }).select().single()
      if (eN) throw eN
      assinatura = nova; criouNova = true
    }
    // ===== ITEM 7: gera lote de fichas de bar (acumulam, validade 90 dias) =====
    try {
      const qtdFichas = parseInt(plano.fichas_bar_mes) || 0
      if (qtdFichas > 0) {
        const agora = new Date()
        const expira = new Date(agora.getTime() + 90 * 24 * 3600 * 1000)
        await supabaseAdmin.from('fichas_plano').insert({
          cliente_id,
          assinatura_id: assinatura.id,
          plano_id,
          quantidade: qtdFichas,
          usadas: 0,
          gerada_em: agora.toISOString(),
          expira_em: expira.toISOString(),
          origem: assinatura_id ? 'renovacao' : 'nova_assinatura',
        })
      }
    } catch (e) { console.error('[fichas-plano] gerar:', e.message) }
    // ===== comanda da mensalidade (finalizada) =====
    // Se sem_comanda=true, a mensalidade é cobrada noutra comanda (ex: no próprio
    // atendimento). Aqui só ativamos/renovamos a assinatura.
    if (req.body.sem_comanda) {
      return res.status(201).json({
        ok: true, assinatura, comanda_id: null, valor,
        plano: plano.nome, data_renovacao: assinatura.data_renovacao, renovou: !!assinatura_id, sem_comanda: true
      })
    }
    try {
      const agora = new Date().toISOString()
      const { data: comanda, error: eC } = await supabaseAdmin.from('comandas').insert({
        agendamento_id: null, cliente_id, colaborador_id: vendedor_id, unidade_id,
        aberta_em: agora, observacao: 'Mensalidade de plano', criado_por: req.usuario.id
      }).select().single()
      if (eC) throw eC
      if (vendedor_id_2) {
        // Divisão: 2 itens somando o valor cheio, um por barbeiro (comissão de cada um).
        const { error: eI } = await supabaseAdmin.from('itens_comanda').insert([
          { comanda_id: comanda.id, tipo: 'plano', descricao: 'Mensalidade — ' + plano.nome + ' (1/2)', quantidade: 1, valor_unit: valSplit1, colaborador_id: vendedor_id },
          { comanda_id: comanda.id, tipo: 'plano', descricao: 'Mensalidade — ' + plano.nome + ' (2/2)', quantidade: 1, valor_unit: valSplit2, colaborador_id: vendedor_id_2 }
        ])
        if (eI) throw eI
      } else {
        const { error: eI } = await supabaseAdmin.from('itens_comanda').insert({
          comanda_id: comanda.id, tipo: 'plano',
          descricao: 'Mensalidade — ' + plano.nome,
          quantidade: 1, valor_unit: valor, colaborador_id: vendedor_id
        })
        if (eI) throw eI
      }
      const pagamentos = [{ forma: forma_pgto, valor: valor }]
      const { error: eF } = await supabaseAdmin.from('comandas').update({
        status: 'finalizada', forma_pgto, pagamentos,
        subtotal: valor, total: valor, desconto: 0, finalizada_em: agora
      }).eq('id', comanda.id)
      if (eF) throw eF
      return res.status(201).json({
        ok: true, assinatura, comanda_id: comanda.id, valor,
        plano: plano.nome, data_renovacao: assinatura.data_renovacao, renovou: !!assinatura_id
      })
    } catch (eComanda) {
      // rollback da assinatura (não queremos ativar/renovar sem registrar o pagamento)
      try {
        if (criouNova && assinatura) {
          await supabaseAdmin.from('assinaturas').delete().eq('id', assinatura.id)
        } else if (antes && assinatura_id) {
          await supabaseAdmin.from('assinaturas').update({
            data_renovacao: antes.data_renovacao, status: antes.status,
            vendedor_id: antes.vendedor_id, vendedor_id_2: antes.vendedor_id_2, valor_split_1: antes.valor_split_1,
            forma_pgto: antes.forma_pgto, plano_id: antes.plano_id
          }).eq('id', assinatura_id)
        }
      } catch (eRb) { console.error('[assinaturas/cobrar rollback]', eRb.message) }
      throw eComanda
    }
  } catch (err) {
    console.error('[assinaturas/cobrar]', err.message)
    return res.status(500).json({ erro: 'Erro ao processar o plano. Nada foi cobrado. ' + (err.message || '') })
  }
})
// ============ FERIADOS ============
// Horário especial 09h-18h (igual sábado). Cadastrados por gerente/proprietário.
router.get('/feriados', autenticar, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('feriados').select('*').order('data', { ascending: true })
    if (error) throw error
    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao listar feriados' })
  }
})
router.post('/feriados', autenticar, ADMIN, async (req, res) => {
  try {
    const { data, descricao, fechado, hora_abre, hora_fecha } = req.body || {}
    if (!data) return res.status(400).json({ erro: 'Informe a data do feriado' })
    const reg = {
      data,
      descricao: (descricao || '').trim() || null,
      fechado: !!fechado,
      hora_abre:  (!fechado && hora_abre)  ? String(hora_abre).slice(0, 5)  : null,
      hora_fecha: (!fechado && hora_fecha) ? String(hora_fecha).slice(0, 5) : null,
      criado_por: req.usuario.id,
    }
    const { data: novo, error } = await supabaseAdmin
      .from('feriados')
      .upsert(reg, { onConflict: 'data' })
      .select().single()
    if (error) throw error
    return res.status(201).json(novo)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao salvar feriado' })
  }
})
router.delete('/feriados/:id', autenticar, ADMIN, async (req, res) => {
  try {
    const { error } = await supabaseAdmin.from('feriados').delete().eq('id', req.params.id)
    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao excluir feriado' })
  }
})
// ===================== PUSH EM MASSA (Fase 3) =====================
const { enviarPushParaVarios, enviarPushParaTodos } = require('./publico')
function _uniq(arr){ return [...new Set(arr.filter(Boolean))] }
async function _fetchPaged(table, select, applyFilters){
  const pageSize = 1000; let from = 0; let all = []
  while (true) {
    let q = supabaseAdmin.from(table).select(select)
    q = applyFilters(q)
    const { data, error } = await q.range(from, from + pageSize - 1)
    if (error || !data) break
    all = all.concat(data)
    if (data.length < pageSize) break
    from += pageSize
    if (from > 60000) break
  }
  return all
}
async function _resolverSegmento(segmento, valor){
  const doze = new Date(); doze.setMonth(doze.getMonth() - 12); const iniISO = doze.toISOString()
  if (segmento === 'assinantes') {
    const { data } = await supabaseAdmin.from('assinaturas').select('cliente_id').eq('status', 'ativa')
    return _uniq((data || []).map(x => x.cliente_id))
  }
  if (segmento === 'aniversariantes') {
    const mes = new Date().getMonth() + 1
    const cls = await _fetchPaged('clientes', 'id, data_nasc', q => q.not('data_nasc', 'is', null))
    return cls.filter(c => { const d = new Date(c.data_nasc); return !isNaN(d) && (d.getUTCMonth() + 1) === mes }).map(c => c.id)
  }
  if (segmento === 'unidade' && valor) {
    const c = await _fetchPaged('comandas', 'cliente_id', q => q.eq('unidade_id', valor).gte('finalizada_em', iniISO).not('cliente_id', 'is', null))
    return _uniq(c.map(x => x.cliente_id))
  }
  if (segmento === 'barbeiro' && valor) {
    const c = await _fetchPaged('comandas', 'cliente_id', q => q.eq('colaborador_id', valor).gte('finalizada_em', iniISO).not('cliente_id', 'is', null))
    return _uniq(c.map(x => x.cliente_id))
  }
  if (segmento === 'sumidos') {
    const janela = new Date(Date.now() - 400 * 86400000).toISOString()
    const cmds = await _fetchPaged('comandas', 'cliente_id, finalizada_em', q => q.eq('status', 'finalizada').gte('finalizada_em', janela).not('cliente_id', 'is', null))
    const abs  = await _fetchPaged('agenda_appbarber', 'cliente_id, inicio', q => q.eq('tipo', 'agendamento').is('agendamento_id', null).eq('status', 'realizado').gte('inicio', janela).not('cliente_id', 'is', null))
    const ult = {}
    cmds.forEach(c => { const t = new Date(c.finalizada_em).getTime(); if (!ult[c.cliente_id] || t > ult[c.cliente_id]) ult[c.cliente_id] = t })
    abs.forEach(a => { const t = new Date(a.inicio).getTime(); if (!ult[a.cliente_id] || t > ult[a.cliente_id]) ult[a.cliente_id] = t })
    const ag = Date.now()
    return Object.keys(ult).filter(id => { const dias = (ag - ult[id]) / 86400000; return dias >= 45 && dias <= 365 })
  }
  // todos
  const cls = await _fetchPaged('clientes', 'id', q => q)
  return cls.map(c => c.id)
}
// POST /push-massa  { segmento, valor, titulo, mensagem, tambem_whatsapp }
router.post('/push-massa', autenticar, exigirPerfil('proprietario', 'gerente'), async (req, res) => {
  try {
    const { segmento, valor, titulo, mensagem, tambem_whatsapp } = req.body
    if (!segmento || !mensagem) return res.status(400).json({ erro: 'Informe o segmento e a mensagem' })
    let ids = await _resolverSegmento(segmento, valor)
    ids = ids.slice(0, 50000)
    const ehTodos = (segmento === 'todos')
    if (!ehTodos && !ids.length) return res.json({ alcance: 0, enviados: 0, whatsapp: 0 })
    const payloadPush = {
      titulo: titulo || 'Barbearia 1989',
      corpo: mensagem,
      url: 'https://barbearia1989.com.br'
    }
    const rPush = ehTodos
      ? await enviarPushParaTodos(payloadPush)
      : await enviarPushParaVarios(ids, payloadPush)
    const enviados = rPush.enviados
    let zap = 0
    if (tambem_whatsapp) {
      for (let i = 0; i < ids.length; i += 200) {
        const parte = ids.slice(i, i + 200)
        const { data: cls } = await supabaseAdmin.from('clientes').select('whatsapp').in('id', parte)
        const linhas = (cls || []).filter(c => c.whatsapp).map(c => ({
          destinatario: '55' + ('' + c.whatsapp).replace(/\D/g, ''),
          mensagem, tipo: 'massa', status: 'pendente'
        }))
        if (linhas.length) { await supabaseAdmin.from('notificacoes_whatsapp').insert(linhas); zap += linhas.length }
      }
    }
    return res.json({ alcance: ids.length, enviados, whatsapp: zap })
  } catch (err) {
    console.error('[push-massa]', err.message)
    return res.status(500).json({ erro: 'Erro ao enviar push em massa' })
  }
})
module.exports = router
