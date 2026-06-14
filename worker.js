// Cloudflare Worker - 文件上传与列表服务（带密码保护的删除功能 + 短链接 + 文件名后缀支持 + 在线编辑 + 并排UI/居中优化 + 无缝保存）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const pathParts = url.pathname.split('/').filter(Boolean);

    // 1. 处理上传请求
    if (method === 'POST' && url.pathname === '/upload') {
      return await handleUpload(request, env);
    }

    // 2. 处理主页和列表页
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/list')) {
      return await handleList(env);
    }

    // 3. 处理删除请求
    if (method === 'DELETE' && pathParts[0] === 'delete' && pathParts[1]) {
      return await handleDelete(request, env, pathParts[1]);
    }

    // 4. 处理密码验证请求 (用于编辑前的验证)
    if (method === 'POST' && pathParts[0] === 'verify' && pathParts[1]) {
      return await handleVerify(request, env, pathParts[1]);
    }

    // 5. 处理文件更新请求
    if (method === 'POST' && pathParts[0] === 'update' && pathParts[1]) {
      return await handleUpdate(request, env, pathParts[1]);
    }

    // 6. 处理文件下载/查看
    if (method === 'GET' && pathParts.length > 0) {
      const fileKey = pathParts[0];
      return await handleDownload(request, env, fileKey);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// --- 核心处理函数 ---

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const password = formData.get('password') || '888';

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const fileName = file.name;
    const fileSize = file.size;
    const fileType = file.type;
    const timestamp = Date.now();
    const fileKey = generateShortId();
    
    const fileBuffer = await file.arrayBuffer();

    await env.FILE_STORE.put(fileKey, fileBuffer, {
      metadata: {
        originalName: fileName,
        uploadTime: timestamp,
        size: fileSize,
        type: fileType,
        deletePassword: password
      }
    });

    const indexKey = 'file_list';
    let fileList = [];
    const existingList = await env.FILE_STORE.get(indexKey, { type: 'json' });
    if (existingList) {
      fileList = existingList;
    }
    
    fileList.unshift({
      key: fileKey,
      originalName: fileName,
      uploadTime: timestamp,
      size: fileSize,
      type: fileType,
      hasPassword: password !== '888'
    });

    if (fileList.length > 100) {
      fileList = fileList.slice(0, 100);
    }
    
    await env.FILE_STORE.put(indexKey, JSON.stringify(fileList));

    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Upload successful',
      key: fileKey,
      fileName: fileName,
      hasPassword: password !== '888'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleDelete(request, env, fileKey) {
  try {
    const decodedKey = decodeURIComponent(fileKey);
    let body = {};
    try {
      body = await request.json();
    } catch (e) {}
    const inputPassword = body.password;

    const fileData = await env.FILE_STORE.getWithMetadata(decodedKey);
    if (!fileData) {
      return new Response(JSON.stringify({ error: 'File not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    
    const storedPassword = fileData.metadata.deletePassword || '888';
    if (inputPassword !== storedPassword) {
      return new Response(JSON.stringify({ error: 'Wrong password', message: '密码错误' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    
    const indexKey = 'file_list';
    let fileList = await env.FILE_STORE.get(indexKey, { type: 'json' }) || [];
    fileList = fileList.filter(item => item.key !== decodedKey);
    await env.FILE_STORE.put(indexKey, JSON.stringify(fileList));
    await env.FILE_STORE.delete(decodedKey);
    
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleVerify(request, env, fileKey) {
  try {
    const decodedKey = decodeURIComponent(fileKey);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    
    const fileData = await env.FILE_STORE.getWithMetadata(decodedKey);
    if (!fileData) return new Response(JSON.stringify({ error: 'File not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    
    const storedPassword = fileData.metadata.deletePassword || '888';
    if (body.password !== storedPassword) {
      return new Response(JSON.stringify({ error: 'Wrong password' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleUpdate(request, env, fileKey) {
  try {
    const decodedKey = decodeURIComponent(fileKey);
    const formData = await request.formData();
    const inputPassword = formData.get('password');
    const newContent = formData.get('content');

    const fileData = await env.FILE_STORE.getWithMetadata(decodedKey);
    if (!fileData) return new Response(JSON.stringify({ error: 'File not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

    const storedPassword = fileData.metadata.deletePassword || '888';
    if (inputPassword !== storedPassword) {
      return new Response(JSON.stringify({ error: 'Wrong password' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const textEncoder = new TextEncoder();
    const contentBuffer = textEncoder.encode(newContent);
    const metadata = fileData.metadata;
    metadata.size = contentBuffer.byteLength;
    metadata.uploadTime = Date.now(); // 更新时间

    await env.FILE_STORE.put(decodedKey, contentBuffer, { metadata });

    const indexKey = 'file_list';
    let fileList = await env.FILE_STORE.get(indexKey, { type: 'json' }) || [];
    const fileIndex = fileList.findIndex(item => item.key === decodedKey);
    if (fileIndex > -1) {
      fileList[fileIndex].size = metadata.size;
      fileList[fileIndex].uploadTime = metadata.uploadTime;
      await env.FILE_STORE.put(indexKey, JSON.stringify(fileList));
    }

    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleDownload(request, env, fileKey) {
  const decodedKey = decodeURIComponent(fileKey);
  const fileData = await env.FILE_STORE.getWithMetadata(decodedKey, { type: 'stream' });

  if (!fileData || !fileData.value) {
    return new Response('File not found', { status: 404 });
  }
  
  const { value, metadata } = fileData;
  const fileName = metadata.originalName;
  const fileType = metadata.type;
  
  const viewable = ['.txt', '.json', '.m3u', '.m3u8', '.xml', '.html', '.css', '.js', '.md'];
  const isViewable = viewable.some(function(ext) {
    return fileName.toLowerCase().endsWith(ext);
  });

  const headers = { 
    'Content-Type': fileType || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  };

  if (!isViewable) {
    headers['Content-Disposition'] = 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(fileName);
  }
  
  return new Response(value, { headers });
}

async function handleList(env) {
  const fileList = await env.FILE_STORE.get('file_list', { type: 'json' }) || [];
  const html = generateHTML(fileList);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// --- 辅助函数 ---

function generateShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.getFullYear() + '-' + padZero(date.getMonth() + 1) + '-' + padZero(date.getDate()) + ' ' +
    padZero(date.getHours()) + ':' + padZero(date.getMinutes()) + ':' + padZero(date.getSeconds());
}

function padZero(num) { return num < 10 ? '0' + num : '' + num; }

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isViewableFile(fileName) {
  const exts = ['.txt', '.json', '.m3u', '.m3u8', '.xml', '.html', '.css', '.js', '.md'];
  for (let i = 0; i < exts.length; i++) {
    if (fileName.toLowerCase().endsWith(exts[i])) return true;
  }
  return false;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- HTML 生成 ---

function generateHTML(files) {
  let rows = '';
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileName = escapeHtml(file.originalName);
    const time = formatTime(file.uploadTime);
    const size = formatSize(file.size);
    const isView = isViewableFile(file.originalName);
    const hasPassword = file.hasPassword || false;
    const encodedKey = encodeURIComponent(file.key);
    const encodedName = encodeURIComponent(file.originalName);
    const fileUrl = '/' + encodedKey + '/' + encodedName;
    
    const viewLink = isView ? '<a href="' + fileUrl + '" class="btn-view" target="_blank">查看</a>' : '';
    const editLink = isView ? '<button class="btn-edit" data-key="' + escapeHtml(file.key) + '" data-name="' + escapeHtml(file.originalName) + '" data-url="' + fileUrl + '">编辑</button>' : '';
    const downloadLink = '<a href="' + fileUrl + '" class="btn-download" download="' + escapeHtml(file.originalName) + '">下载</a>';
    const deleteLink = '<button class="btn-delete" data-key="' + escapeHtml(file.key) + '" data-name="' + escapeHtml(file.originalName) + '" data-has-password="' + hasPassword + '">删除</button>';
    
    rows += '<div class="file-item" data-key="' + escapeHtml(file.key) + '">' +
      '<div class="file-name">' + fileName + (isView ? '<span class="badge">可预览</span>' : '') + (hasPassword ? '<span class="badge" style="background: #fff3cd; color: #856404;">密码保护</span>' : '') + '</div>' +
      '<div class="upload-time">' + time + '</div>' +
      '<div class="file-size">' + size + '</div>' +
      '<div class="actions">' + viewLink + editLink + downloadLink + deleteLink + '</div>' +
    '</div>';
  }
  
  if (files.length === 0) {
    rows = '<div class="empty-state">暂无文件，请使用浏览器上传</div>';
  }
  
  let html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n';
  html += '    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  html += '    <title>文档托管</title>\n';
  html += '    <script src="https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.3/ace.js"></script>\n';
  html += '    <style>\n';
  html += '        * { margin: 0; padding: 0; box-sizing: border-box; }\n';
  html += '        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }\n';
  html += '        .container { max-width: 1200px; margin: 0 auto; }\n';
  
  // 并排布局核心样式
  html += '        .top-panels { display: flex; gap: 30px; margin-bottom: 30px; }\n';
  html += '        .header, .upload-area, .file-list { background: white; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n';
  html += '        .top-panels > .header, .top-panels > .upload-area { flex: 1; padding: 30px; }\n';
  html += '        .file-list { margin-bottom: 30px; overflow: hidden; }\n';
  
  html += '        h1 { color: #333; font-size: 28px; margin-bottom: 10px; }\n';
  html += '        .subtitle { color: #666; font-size: 14px; }\n';
  html += '        .stats { background: #f0f0f0; border-radius: 8px; padding: 10px 15px; margin-top: 15px; display: inline-block; font-size: 14px; }\n';
  html += '        .upload-area h2 { font-size: 20px; margin-bottom: 20px; color: #333; }\n';
  html += '        .drop-zone { border: 2px dashed #667eea; border-radius: 12px; padding: 40px; text-align: center; background: #f8f9fa; transition: all 0.3s; cursor: pointer; height: calc(100% - 50px); display: flex; flex-direction: column; justify-content: center; align-items: center; }\n';
  html += '        .drop-zone.drag-over { border-color: #28a745; background: #f0f8ff; }\n';
  html += '        .drop-zone input { display: none; }\n';
  html += '        .upload-icon { font-size: 48px; margin-bottom: 10px; }\n';
  html += '        .upload-progress { margin-top: 20px; display: none; width: 100%; }\n';
  html += '        .progress-bar { width: 100%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; }\n';
  html += '        .progress-fill { width: 0%; height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }\n';
  
  // 列表居中
  html += '        .list-header, .file-item { display: grid; grid-template-columns: 3fr 2fr 1fr 2fr; padding: 15px 20px; align-items: center; text-align: center; }\n';
  html += '        .list-header { background: #f8f9fa; font-weight: 600; color: #495057; border-bottom: 2px solid #dee2e6; }\n';
  html += '        .file-item { border-bottom: 1px solid #eee; transition: background 0.2s; }\n';
  html += '        .file-item:hover { background: #f8f9fa; }\n';
  html += '        .file-name { color: #333; word-break: break-all; }\n';
  html += '        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px; background: #d4edda; color: #155724; vertical-align: middle; }\n';
  html += '        .upload-time, .file-size { color: #6c757d; font-size: 14px; }\n';
  
  html += '        .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }\n';
  
  html += '        .btn-view, .btn-edit, .btn-download, .btn-delete { padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; transition: all 0.2s; display: inline-block; border: none; cursor: pointer; white-space: nowrap; }\n';
  html += '        .btn-view { background: #28a745; color: white; }\n';
  html += '        .btn-view:hover { background: #218838; }\n';
  html += '        .btn-edit { background: #ffc107; color: #212529; }\n';
  html += '        .btn-edit:hover { background: #e0a800; }\n';
  html += '        .btn-download { background: #007bff; color: white; }\n';
  html += '        .btn-download:hover { background: #0056b3; }\n';
  html += '        .btn-delete { background: #dc3545; color: white; }\n';
  html += '        .btn-delete:hover { background: #c82333; }\n';
  html += '        .empty-state { text-align: center; padding: 60px 20px; color: #6c757d; }\n';
  html += '        .refresh-btn { background: #667eea; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; margin-left: 15px; font-size: 14px; }\n';
  html += '        .refresh-btn:hover { background: #5a67d8; }\n';
  html += '        .toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 12px 24px; border-radius: 8px; z-index: 10000; animation: slideIn 0.3s ease; }\n';
  html += '        .toast.success { background: #28a745; }\n';
  html += '        .toast.error { background: #dc3545; }\n';
  html += '        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 2000; justify-content: center; align-items: center; }\n';
  html += '        .modal.active { display: flex; }\n';
  html += '        .modal-content { background: white; border-radius: 12px; padding: 30px; max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }\n';
  html += '        .modal-content h3 { margin-bottom: 20px; color: #333; }\n';
  html += '        .modal-content input { width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 20px; }\n';
  html += '        .modal-content input:focus { outline: none; border-color: #667eea; }\n';
  html += '        .modal-buttons { display: flex; gap: 10px; justify-content: flex-end; }\n';
  html += '        .btn-cancel { padding: 8px 20px; border: 1px solid #ddd; border-radius: 6px; background: white; cursor: pointer; }\n';
  html += '        .btn-cancel:hover { background: #f5f5f5; }\n';
  html += '        .btn-confirm { padding: 8px 20px; border: none; border-radius: 6px; background: #dc3545; color: white; cursor: pointer; }\n';
  html += '        .btn-confirm:hover { background: #c82333; }\n';
  html += '        .btn-confirm-set { padding: 8px 20px; border: none; border-radius: 6px; background: #667eea; color: white; cursor: pointer; }\n';
  html += '        .btn-confirm-set:hover { background: #5a67d8; }\n';
  html += '        .password-hint { font-size: 12px; color: #999; margin-top: -10px; margin-bottom: 20px; }\n';
  
  // 在线编辑器样式
  html += '        .editor-modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #fff; z-index: 3000; flex-direction: column; }\n';
  html += '        .editor-modal.active { display: flex; }\n';
  html += '        .editor-header { padding: 15px 20px; background: #f8f9fa; border-bottom: 1px solid #dee2e6; display: flex; justify-content: space-between; align-items: center; }\n';
  html += '        .editor-title { font-weight: bold; font-size: 16px; color: #333; }\n';
  html += '        .editor-container { flex: 1; position: relative; }\n';
  html += '        #code-editor { position: absolute; top: 0; right: 0; bottom: 0; left: 0; font-size: 14px; }\n';
  
  // 响应式调整
  html += '        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }\n';
  html += '        @media (max-width: 768px) { .top-panels { flex-direction: column; gap: 20px; } .list-header { display: none; } .file-item { grid-template-columns: 1fr; gap: 8px; text-align: center; } .actions { margin-top: 8px; justify-content: center; } }\n';
  html += '        footer { text-align: center; margin-top: 30px; color: rgba(255,255,255,0.8); font-size: 12px; }\n';
  html += '    </style>\n</head>\n<body>\n';
  
  html += '    <div class="container">\n';
  
  // 左右并排布局包裹
  html += '        <div class="top-panels">\n';
  
  html += '            <div class="header">\n                <h1>📄 文档托管</h1>\n                <p class="subtitle">支持浏览器上传和密码保护删除</p>\n';
  html += '                <div class="stats">\n                    📊 共 ' + files.length + ' 个文件\n                    <button class="refresh-btn" onclick="location.reload()">🔄 刷新</button>\n                </div>\n            </div>\n';
  
  html += '            <div class="upload-area">\n                <h2>📤 浏览器上传文件</h2>\n';
  html += '                <div class="drop-zone" id="dropZone">\n                    <div class="upload-icon">📁</div>\n                    <p>点击或拖拽文件到此区域上传</p>\n';
  html += '                    <p style="color: #999; font-size: 12px; margin-top: 10px;">支持任意格式，最大 25MB</p>\n';
  html += '                    <input type="file" id="fileInput" multiple>\n                </div>\n';
  html += '                <div class="upload-progress" id="uploadProgress">\n                    <div class="progress-bar">\n                        <div class="progress-fill" id="progressFill"></div>\n                    </div>\n';
  html += '                    <p id="progressText" style="margin-top: 10px; text-align: center; font-size: 14px;"></p>\n                </div>\n            </div>\n';
  
  html += '        </div>\n'; // 结束 .top-panels
  
  html += '        <div class="file-list">\n            <div class="list-header">\n                <span>文件名</span>\n                <span>上传时间</span>\n                <span>文件大小</span>\n                <span>操作</span>\n            </div>\n';
  html += '            ' + rows + '\n        </div>\n';
  html += '        <footer>Powered by Cloudflare Worker | <a href="https://github.com/bslgw/file-hosting" target="_blank" style="color: orange; text-decoration: none;">@file-hosting</a></footer>\n    </div>\n';

  // 设置密码弹窗
  html += '    <div class="modal" id="passwordModal">\n        <div class="modal-content">\n            <h3>🔒 设置删除密码</h3>\n            <p style="margin-bottom: 15px; color: #666;">为文件 <strong id="uploadingFileName"></strong> 设置删除密码</p>\n            <input type="text" id="deletePasswordInput" placeholder="请输入删除密码" maxlength="20" value="888">\n            <p class="password-hint">💡 默认为 888，可直接确认或修改为自定义密码</p>\n            <div class="modal-buttons">\n                <button class="btn-cancel" id="btnCancelPassword">取消上传</button>\n                <button class="btn-confirm-set" id="btnConfirmPassword">设置删除密码</button>\n            </div>\n        </div>\n    </div>\n';

  // 验证操作(删除/编辑)密码弹窗
  html += '    <div class="modal" id="verifyPasswordModal">\n        <div class="modal-content">\n            <h3 id="verifyTitle">🔐 验证密码</h3>\n            <p style="margin-bottom: 15px; color: #666;"><span id="verifyDesc">请输入文件</span> <strong id="verifyingFileName"></strong> 的密码</p>\n            <input type="text" id="verifyPasswordInput" placeholder="请输入密码（默认: 888）">\n            <p class="password-hint">💡 如果上传时未修改，默认密码为 888</p>\n            <div class="modal-buttons">\n                <button class="btn-cancel" id="btnCancelVerify">取消</button>\n                <button class="btn-confirm" id="btnConfirmVerify">确认</button>\n            </div>\n        </div>\n    </div>\n';

  // 在线编辑器界面
  html += '    <div class="editor-modal" id="editorModal">\n        <div class="editor-header">\n            <div class="editor-title">正在编辑: <span id="editingFileName"></span></div>\n';
  html += '            <div class="modal-buttons">\n                <button class="btn-cancel" id="btnCancelEdit" onclick="location.reload()">关闭</button>\n                <button class="btn-confirm" style="background: #28a745;" id="btnSaveEdit">💾 保存更改</button>\n            </div>\n        </div>\n';
  html += '        <div class="editor-container"><div id="code-editor"></div></div>\n    </div>\n';

  html += '    <script>\n';
  // 核心变量获取
  html += '        const dropZone = document.getElementById("dropZone");\n        const fileInput = document.getElementById("fileInput");\n        const uploadProgress = document.getElementById("uploadProgress");\n        const progressFill = document.getElementById("progressFill");\n        const progressText = document.getElementById("progressText");\n';
  
  html += '        const passwordModal = document.getElementById("passwordModal");\n        const uploadingFileName = document.getElementById("uploadingFileName");\n        const deletePasswordInput = document.getElementById("deletePasswordInput");\n        const btnCancelPassword = document.getElementById("btnCancelPassword");\n        const btnConfirmPassword = document.getElementById("btnConfirmPassword");\n';
  
  html += '        const verifyPasswordModal = document.getElementById("verifyPasswordModal");\n        const verifyingFileName = document.getElementById("verifyingFileName");\n        const verifyPasswordInput = document.getElementById("verifyPasswordInput");\n        const btnCancelVerify = document.getElementById("btnCancelVerify");\n        const btnConfirmVerify = document.getElementById("btnConfirmVerify");\n        const verifyTitle = document.getElementById("verifyTitle");\n        const verifyDesc = document.getElementById("verifyDesc");\n';

  html += '        let passwordResolve = null;\n        let verifyPasswordResolve = null;\n';
  
  // 编辑器相关变量
  html += '        let editor = null;\n        let currentEditKey = null;\n        let currentEditPassword = null;\n';

  html += '        function showToast(message, type) {\n            const toast = document.createElement("div");\n            toast.className = "toast " + type;\n            toast.textContent = message;\n            document.body.appendChild(toast);\n            setTimeout(function() { toast.remove(); }, 3000);\n        }\n';

  // 上传密码逻辑
  html += '        function requestSetPassword(fileName) {\n            return new Promise(function(resolve) {\n                passwordResolve = resolve;\n                uploadingFileName.textContent = fileName;\n                deletePasswordInput.value = "888";\n                passwordModal.classList.add("active");\n                deletePasswordInput.focus();\n                deletePasswordInput.select();\n            });\n        }\n';
  html += '        btnConfirmPassword.addEventListener("click", function() { const password = deletePasswordInput.value.trim() || "888"; passwordModal.classList.remove("active"); if (passwordResolve) { passwordResolve(password); passwordResolve = null; } });\n';
  html += '        btnCancelPassword.addEventListener("click", function() { passwordModal.classList.remove("active"); if (passwordResolve) { passwordResolve(null); passwordResolve = null; } });\n';
  html += '        deletePasswordInput.addEventListener("keypress", function(e) { if (e.key === "Enter") btnConfirmPassword.click(); });\n';

  // 通用验证密码逻辑 (删除/编辑)
  html += '        function requestVerifyPassword(fileName, actionTitle, actionDesc) {\n            return new Promise(function(resolve) {\n                verifyPasswordResolve = resolve;\n                verifyTitle.textContent = actionTitle;\n                verifyDesc.textContent = actionDesc;\n                verifyingFileName.textContent = fileName;\n                verifyPasswordInput.value = "";\n                verifyPasswordModal.classList.add("active");\n                verifyPasswordInput.focus();\n            });\n        }\n';
  html += '        btnConfirmVerify.addEventListener("click", function() { const password = verifyPasswordInput.value.trim(); if (!password) { showToast("请输入密码", "error"); return; } verifyPasswordModal.classList.remove("active"); if (verifyPasswordResolve) { verifyPasswordResolve(password); verifyPasswordResolve = null; } });\n';
  html += '        btnCancelVerify.addEventListener("click", function() { verifyPasswordModal.classList.remove("active"); if (verifyPasswordResolve) { verifyPasswordResolve(null); verifyPasswordResolve = null; } });\n';
  html += '        verifyPasswordInput.addEventListener("keypress", function(e) { if (e.key === "Enter") btnConfirmVerify.click(); });\n';

  // 文件上传
  html += '        async function uploadFile(file, password) {\n            const formData = new FormData(); formData.append("file", file); formData.append("password", password);\n            try {\n                const response = await fetch("/upload", { method: "POST", body: formData });\n                const result = await response.json();\n                if (result.success) {\n                    showToast("✓ " + file.name + " 上传成功", "success"); setTimeout(() => location.reload(), 1500); return true;\n                } else { showToast("✗ 上传失败: " + result.error, "error"); return false; }\n            } catch (error) { showToast("✗ 上传失败: " + error.message, "error"); return false; }\n        }\n';
  html += '        async function uploadFiles(files) {\n            if (files.length === 0) return;\n            const pw = await requestSetPassword(files.length === 1 ? files[0].name : files.length + " 个文件");\n            if (pw === null) { showToast("已取消上传", "error"); return; }\n            uploadProgress.style.display = "block";\n            let completed = 0;\n            for (let i = 0; i < files.length; i++) {\n                progressText.textContent = "正在上传: " + files[i].name + " (" + (i+1) + "/" + files.length + ")";\n                progressFill.style.width = ((i+1)/files.length*100) + "%";\n                if (await uploadFile(files[i], pw)) completed++;\n                if (i < files.length - 1) await new Promise(r => setTimeout(r, 500));\n            }\n            progressText.textContent = "上传完成！成功: " + completed + "/" + files.length;\n            setTimeout(() => { uploadProgress.style.display = "none"; progressFill.style.width = "0%"; }, 2000);\n        }\n';
  html += '        dropZone.addEventListener("click", () => fileInput.click());\n        dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });\n        dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));\n        dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("drag-over"); uploadFiles(Array.from(e.dataTransfer.files)); });\n        fileInput.addEventListener("change", e => { uploadFiles(Array.from(e.target.files)); fileInput.value = ""; });\n';

  // 文件删除
  html += '        async function deleteFile(key, fileName) {\n            const password = await requestVerifyPassword(fileName, "🔐 验证删除密码", "请输入删除文件");\n            if (password === null) return;\n            try {\n                const response = await fetch("/delete/" + encodeURIComponent(key), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password }) });\n                const result = await response.json();\n                if (result.success) { showToast("✓ 已删除", "success"); setTimeout(() => location.reload(), 800); }\n                else if (response.status === 403) showToast("✗ 密码错误，无法删除", "error");\n                else showToast("✗ 删除失败: " + result.error, "error");\n            } catch (error) { showToast("✗ 删除失败: " + error.message, "error"); }\n        }\n';
  html += '        document.querySelectorAll(".btn-delete").forEach(btn => btn.addEventListener("click", function() { deleteFile(btn.getAttribute("data-key"), btn.getAttribute("data-name")); }));\n';

  // 文件在线编辑
  html += '        async function editFile(key, name, url) {\n            const password = await requestVerifyPassword(name, "📝 验证编辑密码", "请输入编辑文件");\n            if (password === null) return;\n            try {\n                showToast("正在验证密码...", "success");\n                const verifyRes = await fetch("/verify/" + encodeURIComponent(key), { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({password: password}) });\n                if (!verifyRes.ok) throw new Error(verifyRes.status === 403 ? "密码错误" : "验证失败");\n\n                showToast("正在加载内容...", "success");\n                const res = await fetch(url);\n                if (!res.ok) throw new Error("无法读取文件内容");\n                const content = await res.text();\n\n                if (!editor) {\n                    editor = ace.edit("code-editor");\n                    editor.setTheme("ace/theme/chrome");\n                    editor.setFontSize(14);\n                }\n                const ext = name.split(".").pop().toLowerCase();\n                const modes = { "js": "javascript", "html": "html", "css": "css", "json": "json", "md": "markdown", "xml": "xml", "txt": "text" };\n                editor.session.setMode("ace/mode/" + (modes[ext] || "text"));\n                editor.setValue(content, -1);\n                \n                currentEditKey = key;\n                currentEditPassword = password;\n                document.getElementById("editingFileName").textContent = name;\n                document.getElementById("editorModal").classList.add("active");\n            } catch (error) {\n                showToast("✗ 加载失败: " + error.message, "error");\n            }\n        }\n';
  
  html += '        document.querySelectorAll(".btn-edit").forEach(btn => btn.addEventListener("click", function() { editFile(btn.getAttribute("data-key"), btn.getAttribute("data-name"), btn.getAttribute("data-url")); }));\n';
  
  // 保存编辑内容 (移除了自动关闭和刷新，实现无缝保存)
  html += '        document.getElementById("btnSaveEdit").addEventListener("click", async function() {\n            const content = editor.getValue();\n            const formData = new FormData();\n            formData.append("password", currentEditPassword);\n            formData.append("content", content);\n            try {\n                document.getElementById("btnSaveEdit").textContent = "保存中...";\n                const response = await fetch("/update/" + encodeURIComponent(currentEditKey), { method: "POST", body: formData });\n                const result = await response.json();\n                if (result.success) {\n                    showToast("✓ 保存成功", "success");\n                } else if (response.status === 403) {\n                    showToast("✗ 密码错误，无法保存", "error");\n                } else {\n                    showToast("✗ 保存失败: " + result.error, "error");\n                }\n            } catch (error) {\n                showToast("✗ 保存出错: " + error.message, "error");\n            } finally {\n                document.getElementById("btnSaveEdit").textContent = "💾 保存更改";\n            }\n        });\n';

  html += '    </script>\n</body>\n</html>';
  return html;
}
