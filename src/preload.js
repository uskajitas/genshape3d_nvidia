const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  workerId: process.env.WORKER_ID || 'unknown',
  getState: () => ipcRenderer.invoke('get-state'),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  onJobUpdate: (cb) => {
    ipcRenderer.on('job-update', (_e, data) => cb(data));
  },
});
