const response = require('../response');
const moduleCatalog = require('../services/orchestrationModuleCatalog');
const { createOrchestrationService } = require('../services/orchestrationService');

function sendError(res, log, label, error) {
  log.error?.(label, { error: error.message, code: error.code });
  const code = error.code || 'BAD_REQUEST';
  if (['VERSION_CONFLICT', 'PLAN_REVISION_CONFLICT', 'NODE_RUNNING', 'NODE_ALREADY_SUCCEEDED', 'NODE_NOT_READY', 'PLAN_RUNNING_NODE_CONFLICT', 'REQUEST_HASH_CONFLICT'].includes(code)) {
    return response.error(res, 409, code, error.message, error.details);
  }
  if (['ORCHESTRATION_NOT_FOUND', 'ORCHESTRATION_NODE_NOT_FOUND'].includes(code)) {
    return response.error(res, 404, code, error.message, error.details);
  }
  return response.error(res, 400, code, error.message, error.details);
}

module.exports = function orchestrationRoutes(db, log = console) {
  const service = createOrchestrationService(db);
  return {
    listModules(req, res) {
      try { response.success(res, moduleCatalog.listModules(req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration modules list', error); }
    },
    getModule(req, res) {
      const item = moduleCatalog.getModule(req.params.moduleId);
      if (!item) return response.error(res, 404, 'MODULE_CONTRACT_MISSING', '本地尚未登记该模块合同；它仍可作为未知模块写入计划并由 Codex 或人工执行');
      return response.success(res, item);
    },
    listSessions(req, res) {
      try { response.success(res, service.listSessions(req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration session list', error); }
    },
    onboarding(req, res) {
      try { response.success(res, service.onboarding()); }
      catch (error) { sendError(res, log, 'orchestration onboarding', error); }
    },
    createSession(req, res) {
      try {
        const result = service.createSession(req.body || {});
        if (result.reused) return response.success(res, result);
        return response.created(res, result);
      } catch (error) { sendError(res, log, 'orchestration session create', error); }
    },
    getSession(req, res) {
      try {
        const result = service.getBundle(req.params.id, req.query || {});
        if (!result) return response.error(res, 404, 'ORCHESTRATION_NOT_FOUND', '编排任务不存在');
        return response.success(res, result);
      } catch (error) { sendError(res, log, 'orchestration session get', error); }
    },
    updateSession(req, res) {
      try { response.success(res, service.updateSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session update', error); }
    },
    submitPlan(req, res) {
      try { response.success(res, service.submitPlan(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration plan submit', error); }
    },
    confirmPlan(req, res) {
      try { response.success(res, service.confirmPlan(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration plan confirm', error); }
    },
    startSession(req, res) {
      try { response.success(res, service.startSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session start', error); }
    },
    updateNode(req, res) {
      try { response.success(res, service.updateNode(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node update', error); }
    },
    retryNode(req, res) {
      try { response.success(res, service.retryNode(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node retry', error); }
    },
    actOnNode(req, res) {
      try { response.success(res, service.actOnNode(req.params.id, req.params.nodeId, req.params.action, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration node action', error); }
    },
    reserveExternalRequest(req, res) {
      try { response.success(res, service.reserveExternalRequest(req.params.id, req.params.nodeId, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration external request reserve', error); }
    },
    pauseSession(req, res) {
      try { response.success(res, service.pauseSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session pause', error); }
    },
    resumeSession(req, res) {
      try { response.success(res, service.resumeSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration session resume', error); }
    },
    saveCheckpoint(req, res) {
      try { response.success(res, service.saveCheckpoint(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration checkpoint save', error); }
    },
    exportSession(req, res) {
      try { response.success(res, service.exportSession(req.params.id)); }
      catch (error) { sendError(res, log, 'orchestration session export', error); }
    },
    artifacts(req, res) {
      try { response.success(res, { schema_version: 1, items: service.listArtifacts(req.params.id, req.query || {}) }); }
      catch (error) { sendError(res, log, 'orchestration artifacts list', error); }
    },
    registerArtifact(req, res) {
      try { response.created(res, service.recordArtifact(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration artifact register', error); }
    },
    feedback(req, res) {
      try { response.success(res, { schema_version: 1, items: service.listFeedback(req.params.id) }); }
      catch (error) { sendError(res, log, 'orchestration feedback list', error); }
    },
    recordFeedback(req, res) {
      try { response.created(res, service.recordFeedback(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration feedback record', error); }
    },
    delivery(req, res) {
      try { response.success(res, service.latestDelivery(req.params.id) || { status: 'not_prepared', items: [] }); }
      catch (error) { sendError(res, log, 'orchestration delivery get', error); }
    },
    prepareDelivery(req, res) {
      try { response.created(res, service.deliverSession(req.params.id, req.body || {})); }
      catch (error) { sendError(res, log, 'orchestration delivery prepare', error); }
    },
    events(req, res) {
      try { response.success(res, service.listEvents(req.params.id, req.query || {})); }
      catch (error) { sendError(res, log, 'orchestration events list', error); }
    },
    recordEvent(req, res) {
      try {
        const result = service.recordEvent(req.params.id, req.body || {});
        return response.success(res, result);
      } catch (error) { return sendError(res, log, 'orchestration event record', error); }
    },
  };
};
