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

    // 处理删除请求 - 现在需要验证密码
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
    const password = formData.get('password') || '888'; // 获取密码，默认为888
    
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
        deletePassword: password // 存储删除密码
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
      hasPassword: password !== '888' // 标记是否设置了自定义密码（不存储密码明文到列表）
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
    
    // 获取请求体中的密码
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      // 如果没有请求体，继续处理
    }
    const inputPassword = body.password;
    
    // 获取文件信息
    const fileData = await env.FILE_STORE.getWithMetadata(fileKey);
    if (!fileData) {
      return new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 验证密码
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
    
    // 密码正确，删除文件
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
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
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
    
    rows = rows + '<div class="file-item" data-key="' + escapeHtml(file.key) + '">' +
      '<div class="file-name">' + fileName + (isView ? '<span class="badge">可预览</span>' : '') + (hasPassword ? '<span class="badge" style="background: #fff3cd; color: #856404;">密码保护</span>' : '') + '</div>' +
      '<div class="upload-time">' + time + '</div>' +
      '<div class="file-size">' + size + '</div>' +
      '<div class="actions">' + viewLink + downloadLink + deleteLink + '</div>' +
    '</div>';
  }
  
  if (files.length === 0) {
    rows = '<div class="empty-state">暂无文件，请使用浏览器上传</div>';
  }
  
  return '<!DOCTYPE html>\n' +
'<html lang="zh-CN">\n' +
'<head>\n' +
'    <meta charset="UTF-8">\n' +
'    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'    <title>文档托管</title>\n' +
'    <style>\n' +
'        * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
'        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }\n' +
'        .container { max-width: 1200px; margin: 0 auto; }\n' +
'        .header { background: white; border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n' +
'        h1 { color: #333; font-size: 28px; margin-bottom: 10px; }\n' +
'        .subtitle { color: #666; font-size: 14px; }\n' +
'        .stats { background: #f0f0f0; border-radius: 8px; padding: 10px 15px; margin-top: 15px; display: inline-block; font-size: 14px; }\n' +
'        .upload-area { background: white; border-radius: 16px; padding: 30px; margin-bottom: 30px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n' +
'        .upload-area h2 { font-size: 20px; margin-bottom: 20px; color: #333; }\n' +
'        .drop-zone { border: 2px dashed #667eea; border-radius: 12px; padding: 40px; text-align: center; background: #f8f9fa; transition: all 0.3s; cursor: pointer; }\n' +
'        .drop-zone.drag-over { border-color: #28a745; background: #f0f8ff; }\n' +
'        .drop-zone input { display: none; }\n' +
'        .upload-icon { font-size: 48px; margin-bottom: 10px; }\n' +
'        .upload-progress { margin-top: 20px; display: none; }\n' +
'        .progress-bar { width: 100%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; }\n' +
'        .progress-fill { width: 0%; height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); transition: width 0.3s; }\n' +
'        .file-list { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.1); }\n' +
'        .list-header { display: grid; grid-template-columns: 3fr 2fr 1fr 1.5fr; background: #f8f9fa; padding: 15px 20px; font-weight: 600; color: #495057; border-bottom: 2px solid #dee2e6; }\n' +
'        .file-item { display: grid; grid-template-columns: 3fr 2fr 1fr 1.5fr; padding: 15px 20px; border-bottom: 1px solid #eee; transition: background 0.2s; align-items: center; }\n' +
'        .file-item:hover { background: #f8f9fa; }\n' +
'        .file-name { color: #333; word-break: break-all; }\n' +
'        .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px; background: #d4edda; color: #155724; }\n' +
'        .upload-time { color: #6c757d; font-size: 14px; }\n' +
'        .file-size { color: #6c757d; font-size: 14px; }\n' +
'        .actions { display: flex; gap: 10px; flex-wrap: wrap; }\n' +
'        .btn-view, .btn-download, .btn-delete { padding: 6px 12px; border-radius: 6px; text-decoration: none; font-size: 13px; transition: all 0.2s; display: inline-block; border: none; cursor: pointer; white-space: nowrap; }\n' +
'        .btn-view { background: #28a745; color: white; }\n' +
'        .btn-view:hover { background: #218838; }\n' +
'        .btn-download { background: #007bff; color: white; }\n' +
'        .btn-download:hover { background: #0056b3; }\n' +
'        .btn-delete { background: #dc3545; color: white; }\n' +
'        .btn-delete:hover { background: #c82333; }\n' +
'        .empty-state { text-align: center; padding: 60px 20px; color: #6c757d; }\n' +
'        .refresh-btn { background: #667eea; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; margin-left: 15px; font-size: 14px; }\n' +
'        .refresh-btn:hover { background: #5a67d8; }\n' +
'        .toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 12px 24px; border-radius: 8px; z-index: 1000; animation: slideIn 0.3s ease; }\n' +
'        .toast.success { background: #28a745; }\n' +
'        .toast.error { background: #dc3545; }\n' +
'        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 2000; justify-content: center; align-items: center; }\n' +
'        .modal.active { display: flex; }\n' +
'        .modal-content { background: white; border-radius: 12px; padding: 30px; max-width: 400px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }\n' +
'        .modal-content h3 { margin-bottom: 20px; color: #333; }\n' +
'        .modal-content input { width: 100%; padding: 10px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; margin-bottom: 20px; }\n' +
'        .modal-content input:focus { outline: none; border-color: #667eea; }\n' +
'        .modal-buttons { display: flex; gap: 10px; justify-content: flex-end; }\n' +
'        .btn-cancel { padding: 8px 20px; border: 1px solid #ddd; border-radius: 6px; background: white; cursor: pointer; }\n' +
'        .btn-confirm { padding: 8px 20px; border: none; border-radius: 6px; background: #dc3545; color: white; cursor: pointer; }\n' +
'        .btn-confirm:hover { background: #c82333; }\n' +
'        .password-hint { font-size: 12px; color: #999; margin-top: -10px; margin-bottom: 20px; }\n' +
'        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }\n' +
'        @media (max-width: 768px) { .list-header { display: none; } .file-item { grid-template-columns: 1fr; gap: 8px; } .actions { margin-top: 8px; } }\n' +
'        footer { text-align: center; margin-top: 30px; color: rgba(255,255,255,0.8); font-size: 12px; }\n' +
'    </style>\n' +
'</head>\n' +
'<body>\n' +
'    <div class="container">\n' +
'        <div class="header">\n' +
'            <h1>📄 文档托管</h1>\n' +
'            <p class="subtitle">支持浏览器上传和密码保护删除</p>\n' +
'            <div class="stats">\n' +
'                📊 共 ' + files.length + ' 个文件\n' +
'                <button class="refresh-btn" onclick="location.reload()">🔄 刷新</button>\n' +
'            </div>\n' +
'        </div>\n' +
'        \n' +
'        <div class="upload-area">\n' +
'            <h2>📤 浏览器上传文件</h2>\n' +
'            <div class="drop-zone" id="dropZone">\n' +
'                <div class="upload-icon">📁</div>\n' +
'                <p>点击或拖拽文件到此区域上传</p>\n' +
'                <p style="color: #999; font-size: 12px; margin-top: 10px;">支持任意格式，最大 25MB</p>\n' +
'                <input type="file" id="fileInput" multiple>\n' +
'            </div>\n' +
'            <div class="upload-progress" id="uploadProgress">\n' +
'                <div class="progress-bar">\n' +
'                    <div class="progress-fill" id="progressFill"></div>\n' +
'                </div>\n' +
'                <p id="progressText" style="margin-top: 10px; text-align: center; font-size: 14px;"></p>\n' +
'            </div>\n' +
'        </div>\n' +
'        \n' +
'        <div class="file-list">\n' +
'            <div class="list-header">\n' +
'                <span>文件名</span>\n' +
'                <span>上传时间</span>\n' +
'                <span>文件大小</span>\n' +
'                <span>操作</span>\n' +
'            </div>\n' +
'            ' + rows + '\n' +
'        </div>\n' +
'        <footer>Powered by Cloudflare Worker | 支持拖拽上传和密码保护删除</footer>\n' +
'    </div>\n' +
'    \n' +
'    <!-- 上传密码设置弹窗 -->\n' +
'    <div class="modal" id="passwordModal">\n' +
'        <div class="modal-content">\n' +
'            <h3>🔒 设置删除密码</h3>\n' +
'            <p style="margin-bottom: 15px; color: #666;">为文件 <strong id="uploadingFileName"></strong> 设置删除密码</p>\n' +
'            <input type="password" id="deletePasswordInput" placeholder="请输入删除密码（默认: 888）" maxlength="20">\n' +
'            <p class="password-hint">💡 留空则使用默认密码: 888</p>\n' +
'            <div class="modal-buttons">\n' +
'                <button class="btn-cancel" id="btnCancelPassword">取消上传</button>\n' +
'                <button class="btn-confirm" id="btnConfirmPassword">确认并上传</button>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <!-- 删除密码验证弹窗 -->\n' +
'    <div class="modal" id="deletePasswordModal">\n' +
'        <div class="modal-content">\n' +
'            <h3>🔐 验证删除密码</h3>\n' +
'            <p style="margin-bottom: 15px; color: #666;">请输入文件 <strong id="deletingFileName"></strong> 的删除密码</p>\n' +
'            <input type="password" id="deletePasswordVerifyInput" placeholder="请输入删除密码">\n' +
'            <div class="modal-buttons">\n' +
'                <button class="btn-cancel" id="btnCancelDelete">取消</button>\n' +
'                <button class="btn-confirm" id="btnConfirmDelete">确认删除</button>\n' +
'            </div>\n' +
'        </div>\n' +
'    </div>\n' +
'    \n' +
'    <script>\n' +
'        const dropZone = document.getElementById("dropZone");\n' +
'        const fileInput = document.getElementById("fileInput");\n' +
'        const uploadProgress = document.getElementById("uploadProgress");\n' +
'        const progressFill = document.getElementById("progressFill");\n' +
'        const progressText = document.getElementById("progressText");\n' +
'        \n' +
'        // 上传密码设置弹窗相关\n' +
'        const passwordModal = document.getElementById("passwordModal");\n' +
'        const uploadingFileName = document.getElementById("uploadingFileName");\n' +
'        const deletePasswordInput = document.getElementById("deletePasswordInput");\n' +
'        const btnCancelPassword = document.getElementById("btnCancelPassword");\n' +
'        const btnConfirmPassword = document.getElementById("btnConfirmPassword");\n' +
'        \n' +
'        // 删除密码验证弹窗相关\n' +
'        const deletePasswordModal = document.getElementById("deletePasswordModal");\n' +
'        const deletingFileName = document.getElementById("deletingFileName");\n' +
'        const deletePasswordVerifyInput = document.getElementById("deletePasswordVerifyInput");\n' +
'        const btnCancelDelete = document.getElementById("btnCancelDelete");\n' +
'        const btnConfirmDelete = document.getElementById("btnConfirmDelete");\n' +
'        \n' +
'        let pendingFiles = [];\n' +
'        let currentUploadPassword = "";\n' +
'        let passwordResolve = null;\n' +
'        let deletePasswordResolve = null;\n' +
'        \n' +
'        function showToast(message, type) {\n' +
'            const toast = document.createElement("div");\n' +
'            toast.className = "toast " + type;\n' +
'            toast.textContent = message;\n' +
'            document.body.appendChild(toast);\n' +
'            setTimeout(() => toast.remove(), 3000);\n' +
'        }\n' +
'        \n' +
'        // 请求用户设置删除密码\n' +
'        function requestDeletePassword(fileName) {\n' +
'            return new Promise((resolve) => {\n' +
'                passwordResolve = resolve;\n' +
'                uploadingFileName.textContent = fileName;\n' +
'                deletePasswordInput.value = "";\n' +
'                passwordModal.classList.add("active");\n' +
'            });\n' +
'        }\n' +
'        \n' +
'        // 确认设置密码\n' +
'        btnConfirmPassword.addEventListener("click", () => {\n' +
'            const password = deletePasswordInput.value.trim() || "888";\n' +
'            passwordModal.classList.remove("active");\n' +
'            if (passwordResolve) {\n' +
'                passwordResolve(password);\n' +
'                passwordResolve = null;\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        // 取消设置密码\n' +
'        btnCancelPassword.addEventListener("click", () => {\n' +
'            passwordModal.classList.remove("active");\n' +
'            if (passwordResolve) {\n' +
'                passwordResolve(null);\n' +
'                passwordResolve = null;\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        // 支持回车键确认\n' +
'        deletePasswordInput.addEventListener("keypress", (e) => {\n' +
'            if (e.key === "Enter") {\n' +
'                btnConfirmPassword.click();\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        // 请求删除密码验证\n' +
'        function requestDeletePassword(fileName) {\n' +
'            return new Promise((resolve) => {\n' +
'                deletePasswordResolve = resolve;\n' +
'                deletingFileName.textContent = fileName;\n' +
'                deletePasswordVerifyInput.value = "";\n' +
'                deletePasswordModal.classList.add("active");\n' +
'                deletePasswordVerifyInput.focus();\n' +
'            });\n' +
'        }\n' +
'        \n' +
'        // 确认删除密码\n' +
'        btnConfirmDelete.addEventListener("click", () => {\n' +
'            const password = deletePasswordVerifyInput.value;\n' +
'            if (!password) {\n' +
'                showToast("请输入删除密码", "error");\n' +
'                return;\n' +
'            }\n' +
'            deletePasswordModal.classList.remove("active");\n' +
'            if (deletePasswordResolve) {\n' +
'                deletePasswordResolve(password);\n' +
'                deletePasswordResolve = null;\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        // 取消删除\n' +
'        btnCancelDelete.addEventListener("click", () => {\n' +
'            deletePasswordModal.classList.remove("active");\n' +
'            if (deletePasswordResolve) {\n' +
'                deletePasswordResolve(null);\n' +
'                deletePasswordResolve = null;\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        // 删除密码输入框回车确认\n' +
'        deletePasswordVerifyInput.addEventListener("keypress", (e) => {\n' +
'            if (e.key === "Enter") {\n' +
'                btnConfirmDelete.click();\n' +
'            }\n' +
'        });\n' +
'        \n' +
'        async function uploadFile(file, password) {\n' +
'            const formData = new FormData();\n' +
'            formData.append("file", file);\n' +
'            formData.append("password", password);\n' +
'            \n' +
'            try {\n' +
'                const response = await fetch("/upload", {\n' +
'                    method: "POST",\n' +
'                    body: formData\n' +
'                });\n' +
'                \n' +
'                const result = await response.json();\n' +
'                \n' +
'                if (result.success) {\n' +
'                    const pwMsg = result.hasPassword ? "（自定义密码）" : "（默认密码: 888）";\n' +
'                    showToast("✓ " + file.name + " 上传成功 " + pwMsg, "success");\n' +
'                    setTimeout(() => location.reload(), 1500);\n' +
'                    return true;\n' +
'                } else {\n' +
'                    showToast("✗ " + file.name + " 上传失败: " + (result.error || "未知错误"), "error");\n' +
'                    return false;\n' +
'                }\n' +
'            } catch (error) {\n' +
'                showToast("✗ " + file.name + " 上传失败: " + error.message, "error");\n' +
'                return false;\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        async function uploadFiles(files) {\n' +
'            if (files.length === 0) return;\n' +
'            \n' +
'            // 如果只有一个文件，请求设置密码\n' +
'            let password = "888";\n' +
'            if (files.length === 1) {\n' +
'                const pw = await requestDeletePassword(files[0].name);\n' +
'                if (pw === null) {\n' +
'                    showToast("已取消上传", "error");\n' +
'                    return;\n' +
'                }\n' +
'                password = pw;\n' +
'            } else {\n' +
'                // 多个文件时，统一设置密码\n' +
'                const pw = await requestDeletePassword(files.length + " 个文件");\n' +
'                if (pw === null) {\n' +
'                    showToast("已取消上传", "error");\n' +
'                    return;\n' +
'                }\n' +
'                password = pw;\n' +
'            }\n' +
'            \n' +
'            uploadProgress.style.display = "block";\n' +
'            let completed = 0;\n' +
'            \n' +
'            for (let i = 0; i < files.length; i++) {\n' +
'                const file = files[i];\n' +
'                progressText.textContent = "正在上传: " + file.name + " (" + (i + 1) + "/" + files.length + ")";\n' +
'                progressFill.style.width = ((i + 1) / files.length * 100) + "%";\n' +
'                \n' +
'                const success = await uploadFile(file, password);\n' +
'                if (success) completed++;\n' +
'                \n' +
'                if (i < files.length - 1) {\n' +
'                    await new Promise(resolve => setTimeout(resolve, 500));\n' +
'                }\n' +
'            }\n' +
'            \n' +
'            progressText.textContent = "上传完成！成功: " + completed + "/" + files.length;\n' +
'            setTimeout(() => {\n' +
'                uploadProgress.style.display = "none";\n' +
'                progressFill.style.width = "0%";\n' +
'            }, 2000);\n' +
'        }\n' +
'        \n' +
'        dropZone.addEventListener("click", () => fileInput.click());\n' +
'        \n' +
'        dropZone.addEventListener("dragover", (e) => {\n' +
'            e.preventDefault();\n' +
'            dropZone.classList.add("drag-over");\n' +
'        });\n' +
'        \n' +
'        dropZone.addEventListener("dragleave", () => {\n' +
'            dropZone.classList.remove("drag-over");\n' +
'        });\n' +
'        \n' +
'        dropZone.addEventListener("drop", (e) => {\n' +
'            e.preventDefault();\n' +
'            dropZone.classList.remove("drag-over");\n' +
'            const files = Array.from(e.dataTransfer.files);\n' +
'            uploadFiles(files);\n' +
'        });\n' +
'        \n' +
'        fileInput.addEventListener("change", (e) => {\n' +
'            const files = Array.from(e.target.files);\n' +
'            uploadFiles(files);\n' +
'            fileInput.value = "";\n' +
'        });\n' +
'        \n' +
'        async function deleteFile(key, fileName) {\n' +
'            // 请求用户输入删除密码\n' +
'            const password = await requestDeletePassword(fileName);\n' +
'            if (password === null) {\n' +
'                showToast("已取消删除", "error");\n' +
'                return;\n' +
'            }\n' +
'            \n' +
'            try {\n' +
'                const response = await fetch("/file/" + encodeURIComponent(key), {\n' +
'                    method: "DELETE",\n' +
'                    headers: {\n' +
'                        "Content-Type": "application/json"\n' +
'                    },\n' +
'                    body: JSON.stringify({ password: password })\n' +
'                });\n' +
'                \n' +
'                const result = await response.json();\n' +
'                \n' +
'                if (result.success) {\n' +
'                    showToast("✓ " + fileName + " 已删除", "success");\n' +
'                    const fileItem = document.querySelector(".file-item[data-key=\\"" + key.replace(/"/g, "\\\\\\"") + "\\"]");\n' +
'                    if (fileItem) {\n' +
'                        fileItem.style.opacity = "0.5";\n' +
'                        fileItem.style.transition = "opacity 0.3s";\n' +
'                    }\n' +
'                    setTimeout(() => location.reload(), 800);\n' +
'                } else if (response.status === 403) {\n' +
'                    showToast("✗ 删除密码错误，无法删除文件", "error");\n' +
'                } else {\n' +
'                    showToast("✗ 删除失败: " + (result.error || "未知错误"), "error");\n' +
'                }\n' +
'            } catch (error) {\n' +
'                showToast("✗ 删除失败: " + error.message, "error");\n' +
'            }\n' +
'        }\n' +
'        \n' +
'        // 为所有删除按钮绑定事件\n' +
'        function bindDeleteButtons() {\n' +
'            document.querySelectorAll(".btn-delete").forEach(btn => {\n' +
'                btn.addEventListener("click", (e) => {\n' +
'                    const key = btn.getAttribute("data-key");\n' +
'                    const name = btn.getAttribute("data-name");\n' +
'                    deleteFile(key, name);\n' +
'                });\n' +
'            });\n' +
'        }\n' +
'        \n' +
'        // 初始绑定\n' +
'        bindDeleteButtons();\n' +
'        \n' +
'        // 点击模态框外部关闭（不关闭，强制用户选择）\n' +
'        // 如果需要点击外部关闭，可以取消下面的注释\n' +
'        /*\n' +
'        passwordModal.addEventListener("click", (e) => {\n' +
'            if (e.target === passwordModal) {\n' +
'                btnCancelPassword.click();\n' +
'            }\n' +
'        });\n' +
'        deletePasswordModal.addEventListener("click", (e) => {\n' +
'            if (e.target === deletePasswordModal) {\n' +
'                btnCancelDelete.click();\n' +
'            }\n' +
'        });\n' +
'        */\n' +
'    </script>\n' +
'</body>\n' +
'</html>';
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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
