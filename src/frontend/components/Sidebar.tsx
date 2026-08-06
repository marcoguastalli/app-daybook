import { NavLink, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useTheme } from "../theme";

export function Sidebar() {
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();

  const logout = async () => {
    await api.logout();
    navigate("/login");
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">app-daybook</div>
      <nav className="sidebar-nav">
        <NavLink to="/" end>
          Daily
        </NavLink>
        <NavLink to="/topics">Topics</NavLink>
        <NavLink to="/admin">Admin</NavLink>
      </nav>
      <div className="sidebar-footer">
        <button type="button" className="ghost" onClick={toggleTheme}>
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        <button type="button" className="ghost" onClick={logout}>
          Logout
        </button>
        <div className="sidebar-version">v{__APP_VERSION__}</div>
      </div>
    </aside>
  );
}
