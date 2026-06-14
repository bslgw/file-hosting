// Cloudflare Worker - 文件上传与列表服务（带密码保护的删除功能）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // 处理上传请求
    if (method === 'POST' && url.pathname === '/upload') {
      return await handleUpload(request, env);
    }

    // 处理文件下载/查看
    if (method === 'GET' && url.pathname.startsWith('/file/')) {
      return await handleDownload(request, env);
    }

    // 处理删除请求 - 需要验证密码
    if (method === 'DELETE' && url.pathname.startsWith('/file/')) {
      return await handleDelete(request, env);
    }

    // 处理主页
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/list')) {
      return await handleList(env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

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
    const fileKey = timestamp + '_' + fileName;
    
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

async function handleDelete(request, env) {
  try {
    const url = new URL(request.url);
    const fileKey = decodeURIComponent(url.pathname.slice(6));
    
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      // 如果没有请求体，继续处理
    }
    const inputPassword = body.password;
    
    const fileData = await env.FILE_STORE.getWithMetadata(fileKey);
    if (!fileData) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const storedPassword = fileData.metadata.deletePassword || '888';
    if (inputPassword !== storedPassword) {
      return new Response(JSON.stringify({ 
        error: 'Wrong password', 
        message: '删除密码错误，无法删除文件' 
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const indexKey = 'file_list';
    let fileList = await env.FILE_STORE.get(indexKey, { type: 'json' }) || [];
    fileList = fileList.filter(item => item.key !== fileKey);
    await env.FILE_STORE.put(indexKey, JSON.stringify(fileList));
    
    await env.FILE_STORE.delete(fileKey);
    
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'File deleted successfully' 
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

async function handleDownload(request, env) {
  const url = new URL(request.url);
  const fileKey = decodeURIComponent(url.pathname.slice(6));
  
  const fileData = await env.FILE_STORE.getWithMetadata(fileKey, { type: 'stream' });
  
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
  
  const headers = { 'Content-Type': fileType || 'application/octet-stream' };
  
  if (!isViewable) {
    headers['Content-Disposition'] = 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(fileName);
  }
  
  return new Response(value, { headers });
}

async function handleList(env) {
  const fileList = await env.FILE_STORE.get('file_list', { type: 'json' }) || [];
  const html = generateHTML(fileList);
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

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
    const viewLink = isView ? '<a href="/file/' + encodedKey + '" class="btn-view" target="_blank">查看</a>' : '';
    const downloadLink = '<a href="/file/' + encodedKey + '" class="btn-download" download>下载</a>';
    const deleteLink = '<button class="btn-delete" data-key="' + escapeHtml(file.key) + '" data-name="' + escapeHtml(file.originalName) + '" data-has-password="' + hasPassword + '">删除</button>';
    
    rows += '<div class="file-item" data-key="' + escapeHtml(file.key) + '">' +
      '<div class="file-name">' + fileName + (isView ? '<span class="badge">可预览</span>' : '') + (hasPassword ? '<span class="badge" style="background: #fff3cd; color: #856404;">密码保护</span>' : '') + '</div>' +
      '<div class="upload-time">' + time + '</div>' +
      '<div class="file-size">' + size + '</div>' +
      '<div class="actions">' + viewLink + downloadLink + deleteLink + '</div>' +
    '</div>';
  }
  
  if (files.length === 0) {
    rows = '<div class="empty-state">暂无文件，请使用浏览器上传</div>';
  }
  
  let html = '<!DOCTYPE html>\n';
  html += '<html lang="zh-CN">\n';
  html += '<head>\n';
  html += '    <meta charset="UTF-8">\n';
  html += '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  html += '    <title>文档托管</title>\n';
  html += '    <style>\n';
  html += '        * { margin: 0; padding: 0; box-sizing: border-box; }\n';
  html += '        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }\n';
  html += '        .container { max-width: 1200px; margin: 0 auto; }\n';
  html += '        .header { background: white; border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n';
  html += '        h1 { color: #333; font-size: 28px; margin-bottom: 10px; }\n';
  html += '        .subtitle { color: #666; font-size: 14px; }\n';
  html += '        .stats { background: #f0f0f0; border-radius: 8px; padding: 10px 15px; margin-top: 15px; display: inline-block; font-size: 14px; }\n';
  html += '        .upload-area { background: white; border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n';
  html += '        .upload-area h2 { font-size: 20px; margin-bottom: 20px; color: #333; }\n';
  html += '        .drop-zone { border: 2px dashed #667eea; border-radius: 12px; padding: 40px; text-align: center; background: #f8f9fa; transition: all 0.3s; cursor: pointer; }\n';
  html += '        .drop-zone.drag-over { border-color: #28a745; background: #f0f8ff; }\n';
  html += '        .drop-zone input { display: none; }\n';
  html += '        .upload-icon { font-size: 48px; margin-bottom: 10px; }\n';
  html += '        .upload-progress { margin-top: 20px; display: none; }\n';
  html += '        .progress-bar { width: 100%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; }\n';
  html += '        .progress-fill { width: 0%; height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }\n';
  html += '        .file-list { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n';
  html += '        .list-header { display: grid; grid-template-columns: 3fr 2fr 1fr 1.5fr; background: #f8f9fa; padding: 15px 20px; font-weight: 600; color: #495057; border-bottom: 2px solid #dee2e6; }\n';
  html += '        .file-item { display: grid; grid-template-columns: 3fr 2fr 1fr 1.5fr; padding: 15px 20px; border-bottom: 1px solid #eee; transition: background 0.2s; align-items: center; }\n';
  html += '        .file-item:hover { background: #f8f9fa; }\n';
  html += '        .file-name { color: #333; word-break: break-all; }\n';
  html += '        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px; background: #d4edda; color: #155724; }\n';
  html += '        .upload-time { color: #6c757d; font-size: 14px; }\n';
  html += '        .file-size { color: #6c757d; font-size: 14px; }\n';
  html += '        .actions { display: flex; gap: 10px; flex-wrap: wrap; }\n';
  html += '        .btn-view, .btn-download, .btn-delete { padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; transition: all 0.2s; display: inline-block; border: none; cursor: pointer; white-space: nowrap; }\n';
  html += '        .btn-view { background: #28a745; color: white; }\n';
  html += '        .btn-view:hover { background: #218838; }\n';
  html += '        .btn-download { background: #007bff; color: white; }\n';
  html += '        .btn-download:hover { background: #0056b3; }\n';
  html += '        .btn-delete { background: #dc3545; color: white; }\n';
  html += '        .btn-delete:hover { background: #c82333; }\n';
  html += '        .empty-state { text-align: center; padding: 60px 20px; color: #6c757d; }\n';
  html += '        .refresh-btn { background: #667eea; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; margin-left: 15px; font-size: 14px; }\n';
  html += '        .refresh-btn:hover { background: #5a67d8; }\n';
  html += '        .toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 12px 24px; border-radius: 8px; z-index: 1000; animation: slideIn 0.3s ease; }\n';
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
  html += '        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }\n';
  html += '        @media (max-width: 768px) { .list-header { display: none; } .file-item { grid-template-columns: 1fr; gap: 8px; } .actions { margin-top: 8px; } }\n';
  html += '        footer { text-align: center; margin-top: 30px; color: rgba(255,255,255,0.8); font-size: 12px; }\n';
  html += '    </style>\n';
  html += '</head>\n';
  html += '<body>\n';
  html += '    <div class="container">\n';
  html += '        <div class="header">\n';
  html += '            <h1>📄 文档托管</h1>\n';
  html += '            <p class="subtitle">支持浏览器上传和密码保护删除</p>\n';
  html += '            <div class="stats">\n';
  html += '                📊 共 ' + files.length + ' 个文件\n';
  html += '                <button class="refresh-btn" onclick="location.reload()">🔄 刷新</button>\n';
  html += '            </div>\n';
  html += '        </div>\n';
  html += '        \n';
  html += '        <div class="upload-area">\n';
  html += '            <h2>📤 浏览器上传文件</h2>\n';
  html += '            <div class="drop-zone" id="dropZone">\n';
  html += '                <div class="upload-icon">📁</div>\n';
  html += '                <p>点击或拖拽文件到此区域上传</p>\n';
  html += '                <p style="color: #999; font-size: 12px; margin-top: 10px;">支持任意格式，最大 25MB</p>\n';
  html += '                <input type="file" id="fileInput" multiple>\n';
  html += '            </div>\n';
  html += '            <div class="upload-progress" id="uploadProgress">\n';
  html += '                <div class="progress-bar">\n';
  html += '                    <div class="progress-fill" id="progressFill"></div>\n';
  html += '                </div>\n';
  html += '                <p id="progressText" style="margin-top: 10px; text-align: center; font-size: 14px;"></p>\n';
  html += '            </div>\n';
  html += '        </div>\n';
  html += '        \n';
  html += '        <div class="file-list">\n';
  html += '            <div class="list-header">\n';
  html += '                <span>文件名</span>\n';
  html += '                <span>上传时间</span>\n';
  html += '                <span>文件大小</span>\n';
  html += '                <span>操作</span>\n';
  html += '            </div>\n';
  html += '            ' + rows + '\n';
  html += '        </div>\n';
  html += '        <footer>Powered by Cloudflare Worker | 支持拖拽上传和密码保护删除</footer>\n';
  html += '    </div>\n';
  html += '    \n';
  html += '    <!-- 上传密码设置弹窗 -->\n';
  html += '    <div class="modal" id="passwordModal">\n';
  html += '        <div class="modal-content">\n';
  html += '            <h3>🔒 设置删除密码</h3>\n';
  html += '            <p style="margin-bottom: 15px; color: #666;">为文件 <strong id="uploadingFileName"></strong> 设置删除密码</p>\n';
  html += '            <input type="text" id="deletePasswordInput" placeholder="请输入删除密码" maxlength="20" value="888">\n';
  html += '            <p class="password-hint">💡 默认为 888，可直接确认或修改为自定义密码</p>\n';
  html += '            <div class="modal-buttons">\n';
  html += '                <button class="btn-cancel" id="btnCancelPassword">取消上传</button>\n';
  html += '                <button class="btn-confirm-set" id="btnConfirmPassword">设置删除密码</button>\n';
  html += '            </div>\n';
  html += '        </div>\n';
  html += '    </div>\n';
  html += '    \n';
  html += '    <!-- 删除密码验证弹窗 -->\n';
  html += '    <div class="modal" id="deletePasswordModal">\n';
  html += '        <div class="modal-content">\n';
  html += '            <h3>🔐 验证删除密码</h3>\n';
  html += '            <p style="margin-bottom: 15px; color: #666;">请输入文件 <strong id="deletingFileName"></strong> 的删除密码</p>\n';
  html += '            <input type="text" id="deletePasswordVerifyInput" placeholder="请输入删除密码（默认: 888）">\n';
  html += '            <p class="password-hint">💡 如果上传时未修改，默认密码为 888</p>\n';
  html += '            <div class="modal-buttons">\n';
  html += '                <button class="btn-cancel" id="btnCancelDelete">取消</button>\n';
  html += '                <button class="btn-confirm" id="btnConfirmDelete">确认删除</button>\n';
  html += '            </div>\n';
  html += '        </div>\n';
  html += '    </div>\n';
  html += '    \n';
  html += '    <script>\n';
  html += '        const dropZone = document.getElementById("dropZone");\n';
  html += '        const fileInput = document.getElementById("fileInput");\n';
  html += '        const uploadProgress = document.getElementById("uploadProgress");\n';
  html += '        const progressFill = document.getElementById("progressFill");\n';
  html += '        const progressText = document.getElementById("progressText");\n';
  html += '        \n';
  html += '        const passwordModal = document.getElementById("passwordModal");\n';
  html += '        const uploadingFileName = document.getElementById("uploadingFileName");\n';
  html += '        const deletePasswordInput = document.getElementById("deletePasswordInput");\n';
  html += '        const btnCancelPassword = document.getElementById("btnCancelPassword");\n';
  html += '        const btnConfirmPassword = document.getElementById("btnConfirmPassword");\n';
  html += '        \n';
  html += '        const deletePasswordModal = document.getElementById("deletePasswordModal");\n';
  html += '        const deletingFileName = document.getElementById("deletingFileName");\n';
  html += '        const deletePasswordVerifyInput = document.getElementById("deletePasswordVerifyInput");\n';
  html += '        const btnCancelDelete = document.getElementById("btnCancelDelete");\n';
  html += '        const btnConfirmDelete = document.getElementById("btnConfirmDelete");\n';
  html += '        \n';
  html += '        let passwordResolve = null;\n';
  html += '        let deletePasswordResolve = null;\n';
  html += '        \n';
  html += '        function showToast(message, type) {\n';
  html += '            const toast = document.createElement("div");\n';
  html += '            toast.className = "toast " + type;\n';
  html += '            toast.textContent = message;\n';
  html += '            document.body.appendChild(toast);\n';
  html += '            setTimeout(function() { toast.remove(); }, 3000);\n';
  html += '        }\n';
  html += '        \n';
  html += '        function requestSetPassword(fileName) {\n';
  html += '            return new Promise(function(resolve) {\n';
  html += '                passwordResolve = resolve;\n';
  html += '                uploadingFileName.textContent = fileName;\n';
  html += '                deletePasswordInput.value = "888";\n';
  html += '                passwordModal.classList.add("active");\n';
  html += '                deletePasswordInput.focus();\n';
  html += '                deletePasswordInput.select();\n';
  html += '            });\n';
  html += '        }\n';
  html += '        \n';
  html += '        btnConfirmPassword.addEventListener("click", function() {\n';
  html += '            const password = deletePasswordInput.value.trim() || "888";\n';
  html += '            passwordModal.classList.remove("active");\n';
  html += '            if (passwordResolve) {\n';
  html += '                passwordResolve(password);\n';
  html += '                passwordResolve = null;\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        btnCancelPassword.addEventListener("click", function() {\n';
  html += '            passwordModal.classList.remove("active");\n';
  html += '            if (passwordResolve) {\n';
  html += '                passwordResolve(null);\n';
  html += '                passwordResolve = null;\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        deletePasswordInput.addEventListener("keypress", function(e) {\n';
  html += '            if (e.key === "Enter") {\n';
  html += '                btnConfirmPassword.click();\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        function requestDeletePassword(fileName) {\n';
  html += '            return new Promise(function(resolve) {\n';
  html += '                deletePasswordResolve = resolve;\n';
  html += '                deletingFileName.textContent = fileName;\n';
  html += '                deletePasswordVerifyInput.value = "";\n';
  html += '                deletePasswordModal.classList.add("active");\n';
  html += '                deletePasswordVerifyInput.focus();\n';
  html += '            });\n';
  html += '        }\n';
  html += '        \n';
  html += '        btnConfirmDelete.addEventListener("click", function() {\n';
  html += '            const password = deletePasswordVerifyInput.value.trim();\n';
  html += '            if (!password) {\n';
  html += '                showToast("请输入删除密码", "error");\n';
  html += '                return;\n';
  html += '            }\n';
  html += '            deletePasswordModal.classList.remove("active");\n';
  html += '            if (deletePasswordResolve) {\n';
  html += '                deletePasswordResolve(password);\n';
  html += '                deletePasswordResolve = null;\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        btnCancelDelete.addEventListener("click", function() {\n';
  html += '            deletePasswordModal.classList.remove("active");\n';
  html += '            if (deletePasswordResolve) {\n';
  html += '                deletePasswordResolve(null);\n';
  html += '                deletePasswordResolve = null;\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        deletePasswordVerifyInput.addEventListener("keypress", function(e) {\n';
  html += '            if (e.key === "Enter") {\n';
  html += '                btnConfirmDelete.click();\n';
  html += '            }\n';
  html += '        });\n';
  html += '        \n';
  html += '        async function uploadFile(file, password) {\n';
  html += '            const formData = new FormData();\n';
  html += '            formData.append("file", file);\n';
  html += '            formData.append("password", password);\n';
  html += '            \n';
  html += '            try {\n';
  html += '                const response = await fetch("/upload", {\n';
  html += '                    method: "POST",\n';
  html += '                    body: formData\n';
  html += '                });\n';
  html += '                \n';
  html += '                const result = await response.json();\n';
  html += '                \n';
  html += '                if (result.success) {\n';
  html += '                    const pwMsg = result.hasPassword ? "（自定义密码）" : "（默认密码: 888）";\n';
  html += '                    showToast("✓ " + file.name + " 上传成功 " + pwMsg, "success");\n';
  html += '                    setTimeout(function() { location.reload(); }, 1500);\n';
  html += '                    return true;\n';
  html += '                } else {\n';
  html += '                    showToast("✗ " + file.name + " 上传失败: " + (result.error || "未知错误"), "error");\n';
  html += '                    return false;\n';
  html += '                }\n';
  html += '            } catch (error) {\n';
  html += '                showToast("✗ " + file.name + " 上传失败: " + error.message, "error");\n';
  html += '                return false;\n';
  html += '            }\n';
  html += '        }\n';
  html += '        \n';
  html += '        async function uploadFiles(files) {\n';
  html += '            if (files.length === 0) return;\n';
  html += '            \n';
  html += '            let password = "888";\n';
  html += '            if (files.length === 1) {\n';
  html += '                const pw = await requestSetPassword(files[0].name);\n';
  html += '                if (pw === null) {\n';
  html += '                    showToast("已取消上传", "error");\n';
  html += '                    return;\n';
  html += '                }\n';
  html += '                password = pw;\n';
  html += '            } else {\n';
  html += '                const pw = await requestSetPassword(files.length + " 个文件");\n';
  html += '                if (pw === null) {\n';
  html += '                    showToast("已取消上传", "error");\n';
  html += '                    return;\n';
  html += '                }\n';
  html += '                password = pw;\n';
  html += '            }\n';
  html += '            \n';
  html += '            uploadProgress.style.display = "block";\n';
  html += '            let completed = 0;\n';
  html += '            \n';
  html += '            for (let i = 0; i < files.length; i++) {\n';
  html += '                const file = files[i];\n';
  html += '                progressText.textContent = "正在上传: " + file.name + " (" + (i + 1) + "/" + files.length + ")";\n';
  html += '                progressFill.style.width = ((i + 1) / files.length * 100) + "%";\n';
  html += '                \n';
  html += '                const success = await uploadFile(file, password);\n';
  html += '                if (success) completed++;\n';
  html += '                \n';
  html += '                if (i < files.length - 1) {\n';
  html += '                    await new Promise(function(resolve) { setTimeout(resolve, 500); });\n';
  html += '                }\n';
  html += '            }\n';
  html += '            \n';
  html += '            progressText.textContent = "上传完成！成功: " + completed + "/" + files.length;\n';
  html += '            setTimeout(function() {\n';
  html += '                uploadProgress.style.display = "none";\n';
  html += '                progressFill.style.width = "0%";\n';
  html += '            }, 2000);\n';
  html += '        }\n';
  html += '        \n';
  html += '        dropZone.addEventListener("click", function() { fileInput.click(); });\n';
  html += '        \n';
  html += '        dropZone.addEventListener("dragover", function(e) {\n';
  html += '            e.preventDefault();\n';
  html += '            dropZone.classList.add("drag-over");\n';
  html += '        });\n';
  html += '        \n';
  html += '        dropZone.addEventListener("dragleave", function() {\n';
  html += '            dropZone.classList.remove("drag-over");\n';
  html += '        });\n';
  html += '        \n';
  html += '        dropZone.addEventListener("drop", function(e) {\n';
  html += '            e.preventDefault();\n';
  html += '            dropZone.classList.remove("drag-over");\n';
  html += '            const files = Array.from(e.dataTransfer.files);\n';
  html += '            uploadFiles(files);\n';
  html += '        });\n';
  html += '        \n';
  html += '        fileInput.addEventListener("change", function(e) {\n';
  html += '            const files = Array.from(e.target.files);\n';
  html += '            uploadFiles(files);\n';
  html += '            fileInput.value = "";\n';
  html += '        });\n';
  html += '        \n';
  html += '        async function deleteFile(key, fileName) {\n';
  html += '            const password = await requestDeletePassword(fileName);\n';
  html += '            if (password === null) {\n';
  html += '                return;\n';
  html += '            }\n';
  html += '            \n';
  html += '            try {\n';
  html += '                const response = await fetch("/file/" + encodeURIComponent(key), {\n';
  html += '                    method: "DELETE",\n';
  html += '                    headers: {\n';
  html += '                        "Content-Type": "application/json"\n';
  html += '                    },\n';
  html += '                    body: JSON.stringify({ password: password })\n';
  html += '                });\n';
  html += '                \n';
  html += '                const result = await response.json();\n';
  html += '                \n';
  html += '                if (result.success) {\n';
  html += '                    showToast("✓ " + fileName + " 已删除", "success");\n';
  html += '                    setTimeout(function() { location.reload(); }, 800);\n';
  html += '                } else if (response.status === 403) {\n';
  html += '                    showToast("✗ 删除密码错误，无法删除文件", "error");\n';
  html += '                } else {\n';
  html += '                    showToast("✗ 删除失败: " + (result.error || "未知错误"), "error");\n';
  html += '                }\n';
  html += '            } catch (error) {\n';
  html += '                showToast("✗ 删除失败: " + error.message, "error");\n';
  html += '            }\n';
  html += '        }\n';
  html += '        \n';
  html += '        document.querySelectorAll(".btn-delete").forEach(function(btn) {\n';
  html += '            btn.addEventListener("click", function() {\n';
  html += '                const key = btn.getAttribute("data-key");\n';
  html += '                const name = btn.getAttribute("data-name");\n';
  html += '                deleteFile(key, name);\n';
  html += '            });\n';
  html += '        });\n';
  html += '    </script>\n';
  html += '</body>\n';
  html += '</html>';
  
  return html;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.getFullYear() + '-' + 
    padZero(date.getMonth() + 1) + '-' + 
    padZero(date.getDate()) + ' ' +
    padZero(date.getHours()) + ':' +
    padZero(date.getMinutes()) + ':' +
    padZero(date.getSeconds());
}

function padZero(num) {
  return num < 10 ? '0' + num : '' + num;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isViewableFile(fileName) {
  const exts = ['.txt', '.json', '.m3u', '.m3u8', '.xml', '.html', '.css', '.js', '.md'];
  for (let i = 0; i < exts.length; i++) {
    if (fileName.toLowerCase().endsWith(exts[i])) {
      return true;
    }
  }
  return false;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
