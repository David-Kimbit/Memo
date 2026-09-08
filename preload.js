const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getData: () => ipcRenderer.invoke('data:get'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  onDataChanged: (cb) => ipcRenderer.on('data:changed', cb),
  onGotoFolder: (cb) => ipcRenderer.on('goto-folder', (event, id) => cb(id)),
  onCreateFolder: (cb) => ipcRenderer.on('create-folder', cb),
  openFolderInMain: (id) => ipcRenderer.send('widget:open-folder', id),
  requestNewFolder: () => ipcRenderer.send('widget:new-folder'),
  setWidgetExpanded: (expanded) => ipcRenderer.send('widget:hover', expanded),
  dragBy: (dy) => ipcRenderer.send('widget:drag-by', dy),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  setPinned: (pinned) => ipcRenderer.send('widget:set-pinned', pinned),
  onForceCollapse: (cb) => ipcRenderer.on('force-collapse', cb),
  openCalculator: () => ipcRenderer.send('open-calculator'),
  sendToCalculator: (value) => ipcRenderer.send('send-to-calculator', value),
  onLoadValue: (cb) => ipcRenderer.on('load-value', (event, value) => cb(value)),
  addAttachment: (sourcePath, name) => ipcRenderer.invoke('attachment:add', { sourcePath, name }),
  openAttachment: (storedName) => ipcRenderer.send('attachment:open', storedName),
  removeAttachment: (storedName) => ipcRenderer.invoke('attachment:remove', storedName),
  readAttachmentDataUrl: (storedName) => ipcRenderer.invoke('attachment:read-data-url', storedName),
});
