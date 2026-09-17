import { api } from '../../utils/api.js';

const BASE = '/template-builder/templates';

export const templateApi = {
  list: () => api.get(BASE),
  get: (id) => api.get(`${BASE}/${id}`),
  create: (data) => api.post(BASE, data),
  update: (id, data) => api.put(`${BASE}/${id}`, data),
  delete: (id) => api.delete(`${BASE}/${id}`),
  compile: (id, mjml) => api.post(`${BASE}/${id}/compile`, { mjml }),
};
