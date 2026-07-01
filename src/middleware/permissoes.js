// ============================================================
// permissoes.js — Perfis de acesso (ITEM 9 — Camada 1: perfis + telas)
// Proprietário SEMPRE vê tudo. Demais seguem a grade; sem config -> padrão.
// Montar no server: app.use('/permissoes', require('./routes/permissoes'))
// ============================================================
const express = require('express')
const router = express.Router()
const { supabaseAdmin } = require('../config/supabase')
const { autenticar, exigirPerfil } = require('../middleware/auth')

const ADMIN = exigirPerfil('proprietario')

// Telas controláveis e o PADRÃO atual (por perfil BASE).
const TELAS = [
  { chave:'operacional', nome:'Operacional',     padrao:['gerente','caixa'] },
  { chave:'financeiro',  nome:'Financeiro',       padrao:['gerente'] },
  { chave:'estoque',     nome:'Estoque',          padrao:['gerente'] },
  { chave:'balanco',     nome:'Balanço',          padrao:['gerente','caixa'] },
  { chave:'comparativo', nome:'Comparativos',     padrao:['gerente'] },
  { chave:'dre',         nome:'Balancete / DRE',  padrao:['gerente'] },
  { chave:'metas',       nome:'Metas',            padrao:['gerente'] },
  { chave:'clientes',    nome:'Clientes',         padrao:['gerente'] },
  { chave:'push',        nome:'Disparos / Push',  padrao:['gerente'] },
  { chave:'cadastros',   nome:'Cadastros',        padrao:['gerente'] },
]
const CHAVES = TELAS.map(t => t.chave)
const BASES_VALIDAS = ['gerente','caixa','colaborador','funcionario']

// padrão embutido por BASE do perfil
function padraoPermite(base, tela) {
  if (base === 'proprietario') return true
  const t = TELAS.find(x => x.chave === tela)
  if (!t) return true
  return t.padrao.includes(base)
}

// lista todos os perfis (fixos + novos)
async function listarPerfis() {
  const { data } = await supabaseAdmin.from('perfis_acesso').select('*').order('fixo', { ascending:false }).order('nome')
  return data || []
}
async function baseDoPerfil(chave) {
  if (chave === 'proprietario') return 'proprietario'
  const { data } = await supabaseAdmin.from('perfis_acesso').select('base').eq('chave', chave).maybeSingle()
  return (data && data.base) || 'colaborador'
}

// resolve permissão efetiva de um perfil (chave) para uma tela: config salva > padrão(base)
async function podeAcessar(perfilChave, tela, baseConhecida) {
  if (perfilChave === 'proprietario') return true
  const { data } = await supabaseAdmin.from('permissoes_tela')
    .select('permitido').eq('perfil', perfilChave).eq('tela', tela).maybeSingle()
  if (data && typeof data.permitido === 'boolean') return data.permitido
  const base = baseConhecida || await baseDoPerfil(perfilChave)
  return padraoPermite(base, tela)
}

// ---------- Middleware exigirTela ----------
function exigirTela(chave) {
  return async (req, res, next) => {
    try {
      const perfil = req.usuario && req.usuario.perfil
      const base = req.usuario && req.usuario.perfil_base
      if (!perfil) return res.status(401).json({ erro: 'Não autenticado' })
      if (perfil === 'proprietario' || base === 'proprietario') return next()
      const ok = await podeAcessar(perfil, chave, base)
      if (!ok) return res.status(403).json({ erro: 'Acesso à tela não permitido para seu perfil.' })
      return next()
    } catch (e) {
      if (padraoPermite(req.usuario && req.usuario.perfil_base, chave)) return next()
      return res.status(403).json({ erro: 'Acesso não permitido.' })
    }
  }
}

// ============ PERFIS (CRUD) ============

// GET /permissoes/perfis — lista perfis
router.get('/perfis', autenticar, ADMIN, async (req, res) => {
  try { return res.json(await listarPerfis()) }
  catch (e) { return res.status(500).json({ erro:'Erro ao listar perfis' }) }
})

// POST /permissoes/perfis  { nome, base }  — cria perfil novo
router.post('/perfis', autenticar, ADMIN, async (req, res) => {
  try {
    const nome = String(req.body.nome || '').trim()
    const base = String(req.body.base || '').trim()
    if (!nome) return res.status(400).json({ erro:'Informe o nome do perfil.' })
    if (!BASES_VALIDAS.includes(base)) return res.status(400).json({ erro:'Base inválida.' })
    // chave: slug do nome (sem acentos/espaços) — garante unicidade
    let chave = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')
    if (!chave) chave = 'perfil'
    // evita colidir com fixos
    const { data: existe } = await supabaseAdmin.from('perfis_acesso').select('chave').eq('chave', chave).maybeSingle()
    if (existe) chave = chave + '_' + Date.now().toString().slice(-4)
    const { data, error } = await supabaseAdmin.from('perfis_acesso')
      .insert({ chave, nome, base, fixo:false }).select().single()
    if (error) throw error
    return res.json({ ok:true, perfil:data })
  } catch (e) {
    console.error('[perfis POST]', e.message)
    return res.status(500).json({ erro:'Erro ao criar perfil: '+e.message })
  }
})

// DELETE /permissoes/perfis/:chave — exclui perfil novo (não pode ser fixo, nem estar em uso)
router.delete('/perfis/:chave', autenticar, ADMIN, async (req, res) => {
  try {
    const chave = req.params.chave
    const { data: p } = await supabaseAdmin.from('perfis_acesso').select('fixo').eq('chave', chave).maybeSingle()
    if (!p) return res.status(404).json({ erro:'Perfil não encontrado.' })
    if (p.fixo) return res.status(400).json({ erro:'Perfis fixos não podem ser excluídos.' })
    // checa se algum colaborador usa
    const { count } = await supabaseAdmin.from('colaboradores').select('id',{count:'exact',head:true}).eq('perfil', chave)
    if (count && count > 0) return res.status(400).json({ erro:'Há '+count+' colaborador(es) com este perfil. Troque-os antes de excluir.' })
    await supabaseAdmin.from('permissoes_tela').delete().eq('perfil', chave)
    await supabaseAdmin.from('perfis_acesso').delete().eq('chave', chave)
    return res.json({ ok:true })
  } catch (e) {
    console.error('[perfis DELETE]', e.message)
    return res.status(500).json({ erro:'Erro ao excluir perfil' })
  }
})

// ============ GRADE DE TELAS ============

// GET /permissoes — grade completa (todos os perfis não-proprietário x telas)
router.get('/', autenticar, ADMIN, async (req, res) => {
  try {
    const perfis = (await listarPerfis()).filter(p => p.chave !== 'proprietario')
    const { data: salvas } = await supabaseAdmin.from('permissoes_tela').select('perfil, tela, permitido')
    const mapa = {}
    ;(salvas || []).forEach(r => { mapa[r.perfil + '|' + r.tela] = r.permitido })
    const grade = {}
    perfis.forEach(p => {
      grade[p.chave] = {}
      CHAVES.forEach(tela => {
        const k = p.chave + '|' + tela
        grade[p.chave][tela] = (k in mapa) ? mapa[k] : padraoPermite(p.base, tela)
      })
    })
    return res.json({ telas: TELAS, perfis, grade })
  } catch (err) {
    console.error('[permissoes GET]', err.message)
    return res.status(500).json({ erro: 'Erro ao carregar permissões' })
  }
})

// POST /permissoes  { grade: { perfilChave: { tela: bool } } }
router.post('/', autenticar, ADMIN, async (req, res) => {
  try {
    const grade = req.body.grade || {}
    const linhas = []
    Object.keys(grade).forEach(perfil => {
      if (perfil === 'proprietario') return
      const g = grade[perfil] || {}
      CHAVES.forEach(tela => {
        if (tela in g) linhas.push({ perfil, tela, permitido: !!g[tela], atualizado_em: new Date().toISOString() })
      })
    })
    if (!linhas.length) return res.status(400).json({ erro: 'Nada para salvar.' })
    const { error } = await supabaseAdmin.from('permissoes_tela').upsert(linhas, { onConflict: 'perfil,tela' })
    if (error) throw error
    return res.json({ ok: true, salvas: linhas.length })
  } catch (err) {
    console.error('[permissoes POST]', err.message)
    return res.status(500).json({ erro: 'Erro ao salvar permissões: ' + err.message })
  }
})

// GET /permissoes/minhas — o front usa para montar o menu do usuário logado
router.get('/minhas', autenticar, async (req, res) => {
  try {
    const perfil = req.usuario.perfil
    const base = req.usuario.perfil_base
    const out = {}
    if (perfil === 'proprietario' || base === 'proprietario') {
      CHAVES.forEach(t => out[t] = true)
      return res.json({ perfil, telas: out })
    }
    const { data: salvas } = await supabaseAdmin.from('permissoes_tela')
      .select('tela, permitido').eq('perfil', perfil)
    const mapa = {}
    ;(salvas || []).forEach(r => { mapa[r.tela] = r.permitido })
    CHAVES.forEach(tela => { out[tela] = (tela in mapa) ? mapa[tela] : padraoPermite(base, tela) })
    return res.json({ perfil, telas: out })
  } catch (err) {
    console.error('[permissoes/minhas]', err.message)
    const out = {}
    CHAVES.forEach(tela => out[tela] = padraoPermite(req.usuario && req.usuario.perfil_base, tela))
    return res.json({ perfil: req.usuario && req.usuario.perfil, telas: out })
  }
})

module.exports = router
module.exports.exigirTela = exigirTela
module.exports.TELAS = TELAS
