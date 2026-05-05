"use client";
import React, { useState, useEffect, useRef } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "/api";

function highlightLog(text: string) {
  const regex = /(ERROR|WARN|Exception|STACK TRACE|SQLITE|OutOfMemory|crash)/gi;
  const parts = text.split(regex);
  return parts.map((part, i) => {
    const pLower = part.toLowerCase();
    if (["error", "exception", "outofmemory", "crash"].includes(pLower)) {
      return <span key={i} className="hl-error">{part}</span>;
    } else if (pLower === "warn") {
      return <span key={i} className="hl-warn">{part}</span>;
    } else if (pLower === "sqlite") {
      return <span key={i} className="hl-sqlite">{part}</span>;
    } else if (pLower === "stack trace") {
      return <span key={i} className="hl-trace">{part}</span>;
    }
    return part;
  });
}

const LogViewer = ({ content }: { content: string }) => {
  if (!content) return <div className="log-viewer-container"><div style={{ color: '#666' }}>No data...</div></div>;
  const lines = content.split('\n');
  const isTruncated = lines.length > 5000;
  const displayLines = isTruncated ? lines.slice(0, 5000) : lines;

  return (
    <div className="log-viewer-container">
      {displayLines.map((line, idx) => (
        <div key={idx} className="log-line">
          {highlightLog(line)}
        </div>
      ))}
      {isTruncated && <div className="log-line hl-warn" style={{ marginTop: '1rem' }}>... [Nội dung quá dài đã bị cắt bớt để bảo vệ trình duyệt (Giới hạn 5000 dòng đầu tiên)] ...</div>}
    </div>
  );
};

export default function AdminApp() {
  const [token, setToken] = useState("");
  const [isLogged, setIsLogged] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [logContent, setLogContent] = useState("");
  const [refreshInterval, setRefreshInterval] = useState(0); // 0 = off, 30, 60
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Dashboard state
  const [health, setHealth] = useState({ backend: "", storage: "" });

  // Search state
  const [searchDate, setSearchDate] = useState("");
  const [searchFile, setSearchFile] = useState("server-console.txt"); // default for PZ
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // Hourly state
  const [hourlyDate, setHourlyDate] = useState("");
  const [hourlyFiles, setHourlyFiles] = useState<string[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("eden_admin_session");
    if (saved) {
      try {
        const session = JSON.parse(saved);
        if (Date.now() < session.expiresAt) {
          setToken(session.token);
          setIsLogged(true);
        } else {
          localStorage.removeItem("eden_admin_session");
        }
      } catch (e) {
        localStorage.removeItem("eden_admin_session");
      }
    }
  }, []);

  const apiFetch = async (endpoint: string, isJson = true) => {
    let currentToken = token;
    // Đọc token trực tiếp từ localStorage để tránh lỗi bất đồng bộ khi F5
    const saved = localStorage.getItem("eden_admin_session");
    if (saved) {
      try {
        const session = JSON.parse(saved);
        if (Date.now() > session.expiresAt) {
          handleLogout();
          throw new Error("Session expired");
        }
        currentToken = session.token;
        // Tự động gia hạn thêm 1 tiếng mỗi khi có thao tác
        session.expiresAt = Date.now() + 60 * 60 * 1000;
        localStorage.setItem("eden_admin_session", JSON.stringify(session));
      } catch (e) {
        // Fallback
      }
    }

    if (!currentToken) {
      handleLogout();
      throw new Error("Unauthorized: No token");
    }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { "Authorization": `Bearer ${currentToken}` }
    });
    if (res.status === 401 || res.status === 403) {
      handleLogout();
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error("Request failed: " + res.status);
    return isJson ? res.json() : res.text();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // Test token by calling storage health
      const res = await fetch(`${API_BASE}/storage/health`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const sessionData = {
          token: token,
          expiresAt: Date.now() + 60 * 60 * 1000 // 1 hour
        };
        localStorage.setItem("eden_admin_session", JSON.stringify(sessionData));
        setIsLogged(true);
        setActiveTab("dashboard");
      } else {
        alert("Token không hợp lệ hoặc Server lỗi!");
      }
    } catch (err) {
      alert("Không thể kết nối đến Backend.");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("eden_admin_session");
    setIsLogged(false);
    setToken("");
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(logContent);
    alert("Copied to clipboard!");
  };

  const fetchLog = async (type: string) => {
    try {
      setLogContent("Loading...");
      const text = await apiFetch(`/logs/latest/${type}`, false);
      setLogContent(text);
    } catch (err: any) {
      if (err.message && err.message.includes("404")) {
        setLogContent("File log chưa tồn tại (Có thể Server Game chưa chạy hoặc chưa sinh ra lỗi/cảnh báo nào).");
      } else {
        setLogContent("Error loading log: " + err.message);
      }
    }
  };

  const fetchDashboard = async () => {
    try {
      const bRes = await fetch(`${API_BASE}/health`);
      const bData = await bRes.json();
      const sData = await apiFetch("/storage/health", true);
      setHealth({ backend: bData.status, storage: sData.status });
    } catch (e) {
      setHealth({ backend: "Error", storage: "Error" });
    }
  };

  const fetchHourlyFiles = async () => {
    if (!hourlyDate) return;
    try {
      const data = await apiFetch(`/logs/hourly?date=${hourlyDate}`, true);
      setHourlyFiles(data.files || []);
    } catch (err) {
      setHourlyFiles([]);
    }
  };

  const fetchHourlyLog = async (file: string) => {
    try {
      setLogContent("Loading...");
      const text = await apiFetch(`/logs/hourly/${hourlyDate}/${file}`, false);
      setLogContent(text);
    } catch (err: any) {
      if (err.message && err.message.includes("404")) {
        setLogContent("File log chưa tồn tại.");
      } else {
        setLogContent("Error: " + err.message);
      }
    }
  };

  const handleSearch = async () => {
    if (!searchDate || !searchFile) return alert("Vui lòng nhập tên File và Ngày cần tìm kiếm.");
    try {
      setSearchResults([]);
      const data = await apiFetch(`/logs/search?q=${encodeURIComponent(searchQuery)}&date=${searchDate}&file=${encodeURIComponent(searchFile)}`, true);
      setSearchResults(data.results || []);
    } catch (err) {
      alert("Lỗi khi tìm kiếm");
    }
  };

  const downloadArchive = () => {
    if (!hourlyDate) return alert("Chọn ngày ở mục Hourly trước khi download archive");
    fetch(`${API_BASE}/logs/download/archive/${hourlyDate}`, {
      headers: { "Authorization": `Bearer ${token}` }
    })
    .then(async res => {
      if (!res.ok) throw new Error("Request failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `archive-${hourlyDate}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    })
    .catch(() => alert("Không tìm thấy archive hoặc lỗi."));
  };

  // Auto Refresh
  useEffect(() => {
    if (activeTab === "console" && refreshInterval > 0) {
      const interval = setInterval(() => fetchLog("console"), refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [activeTab, refreshInterval]);

  // Lấy danh sách ngày có sẵn khi đăng nhập thành công
  useEffect(() => {
    if (isLogged) {
      apiFetch('/logs/dates', true)
        .then(data => {
          setAvailableDates(data.dates || []);
          if (data.dates && data.dates.length > 0) {
            setHourlyDate(data.dates[0]); // Mặc định chọn ngày mới nhất
            setSearchDate(data.dates[0]);
          }
        })
        .catch(() => {});
    }
  }, [isLogged]);

  // Tab switching side effects
  useEffect(() => {
    if (activeTab === "dashboard") fetchDashboard();
    if (activeTab === "errors") fetchLog("errors");
    if (activeTab === "warnings") fetchLog("warnings");
    if (activeTab === "console") fetchLog("console");
  }, [activeTab]);

  // Tự động tải danh sách file khi đổi ngày ở tab hourly
  useEffect(() => {
    if (activeTab === "hourly" && hourlyDate) {
      fetchHourlyFiles();
    }
  }, [hourlyDate, activeTab]);

  if (!isLogged) {
    return (
      <div className="login-container">
        <div className="login-box">
          <h2>Eden Log Admin</h2>
          <form onSubmit={handleLogin}>
            <input 
              type="password" 
              placeholder="Nhập ADMIN_TOKEN" 
              value={token} 
              onChange={e => setToken(e.target.value)}
              required 
            />
            <button type="submit">Đăng Nhập</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className={`sidebar ${isSidebarOpen ? '' : 'collapsed'}`}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', padding: '0 0.5rem' }}>
          <h3 style={{ margin: 0, color: "var(--accent-color)" }}>Eden Bridge</h3>
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="btn" style={{ padding: '0.2rem 0.5rem', margin: 0, background: 'transparent', border: 'none' }}>
            {isSidebarOpen ? '◀' : '▶'}
          </button>
        </div>
        
        <button className={activeTab === "dashboard" ? "active" : ""} onClick={() => setActiveTab("dashboard")}>
          <span className="icon">📊</span>
          <span className="tab-text">Dashboard</span>
        </button>
        
        {/* Tạm ẩn các tab chưa dùng */}
        
        <button className={activeTab === "hourly" ? "active" : ""} onClick={() => setActiveTab("hourly")}>
          <span className="icon">🕒</span>
          <span className="tab-text">Hourly Logs</span>
        </button>
        <button className={activeTab === "search" ? "active" : ""} onClick={() => setActiveTab("search")}>
          <span className="icon">🔍</span>
          <span className="tab-text">Search</span>
        </button>
        <button className={activeTab === "archive" ? "active" : ""} onClick={() => setActiveTab("archive")}>
          <span className="icon">📦</span>
          <span className="tab-text">Archive</span>
        </button>
        <div style={{ flex: 1 }}></div>
        <button onClick={handleLogout} style={{ color: "var(--danger-color)" }}>
          <span className="icon">🚪</span>
          <span className="tab-text">Logout</span>
        </button>
      </div>

      <div className="main-content">
        {activeTab === "dashboard" && (
          <div className="card">
            <h2>Hệ thống Trạng Thái</h2>
            <p><strong>Backend API:</strong> {health.backend === "OK" ? <span style={{color:'green'}}>Online</span> : <span style={{color:'red'}}>Offline</span>}</p>
            <p><strong>Storage WebDAV:</strong> {health.storage === "connected" ? <span style={{color:'green'}}>Connected</span> : <span style={{color:'red'}}>Disconnected</span>}</p>
            <p>Server Time: {new Date().toLocaleString()}</p>
          </div>
        )}

        {(activeTab === "console" || activeTab === "errors" || activeTab === "warnings") && (
          <div>
            <div className="controls">
              <button className="btn" onClick={() => fetchLog(activeTab)}>Refresh</button>
              <button className="btn" onClick={copyToClipboard}>Copy All</button>
              
              {activeTab === "console" && (
                <select className="input" value={refreshInterval} onChange={e => setRefreshInterval(Number(e.target.value))}>
                  <option value={0}>Auto Refresh: OFF</option>
                  <option value={30}>Auto Refresh: 30s</option>
                  <option value={60}>Auto Refresh: 60s</option>
                </select>
              )}
            </div>
            <LogViewer content={logContent} />
          </div>
        )}

        {activeTab === "hourly" && (
          <div>
            <div className="controls">
              <select className="input" value={hourlyDate} onChange={e => setHourlyDate(e.target.value)} style={{ width: "200px", padding: "0.5rem" }}>
                <option value="">-- Chọn ngày --</option>
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            
            <div style={{ display: "flex", gap: "1rem" }}>
              <div style={{ width: "260px", maxHeight: "70vh", overflowY: "auto" }} className="card">
                <h4>Danh sách File</h4>
                {hourlyFiles.map(f => (
                  <div key={f} style={{ marginBottom: "0.5rem" }}>
                    <button className="btn" style={{ width: "100%", textAlign: "left" }} onClick={() => fetchHourlyLog(f)}>📄 {f}</button>
                  </div>
                ))}
                {hourlyFiles.length === 0 && <p style={{color: '#666'}}>Chưa có file nào...</p>}
              </div>
              <div style={{ flex: 1 }}>
                <LogViewer content={logContent} />
              </div>
            </div>
          </div>
        )}

        {activeTab === "search" && (
          <div>
            <div className="controls">
              <select className="input" value={searchDate} onChange={e => setSearchDate(e.target.value)} style={{ width: "200px", padding: "0.5rem" }}>
                <option value="">-- Chọn ngày --</option>
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <input type="text" className="input" value={searchFile} onChange={e => setSearchFile(e.target.value)} placeholder="Tên file log (vd: server-console.txt)" style={{width: "200px"}} />
              <input type="text" className="input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Từ khoá cần tìm..." />
              <button className="btn" onClick={handleSearch}>Tìm Kiếm</button>
            </div>
            <div className="card">
              <h4>Kết quả tìm kiếm ({searchResults.length}):</h4>
              <div style={{ maxHeight: "60vh", overflowY: "auto", fontFamily: "monospace", fontSize: "0.9rem" }}>
                {searchResults.map((res: any, i) => (
                  <div key={i} style={{ borderBottom: "1px solid #333", padding: "0.5rem 0" }}>
                    <span style={{ color: "var(--accent-color)", marginRight: "1rem" }}>[{res.file}] Line {res.line}</span>
                    {highlightLog(res.text)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === "archive" && (
          <div className="card">
            <h2>Tải Archive (ZIP Backup)</h2>
            <p>Lưu ý: Chỉ những ngày đã qua được bật tính năng Archive bằng PowerShell mới có file Zip để tải.</p>
            <div className="controls">
              <select className="input" value={hourlyDate} onChange={e => setHourlyDate(e.target.value)} style={{ width: "200px", padding: "0.5rem" }}>
                <option value="">-- Chọn ngày --</option>
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <button className="btn" onClick={downloadArchive} style={{ backgroundColor: "var(--accent-color)", color: "#000" }}>📥 Tải xuống ZIP</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
