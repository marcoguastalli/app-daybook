import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { DatePicker } from "./components/DatePicker";
import { SearchBar } from "./components/SearchBar";
import { Sidebar } from "./components/Sidebar";
import { todayISO } from "./dates";
import { initTheme } from "./theme";
import { AdminView } from "./views/AdminView";
import { DailyView } from "./views/DailyView";
import { LoginView } from "./views/LoginView";
import { SearchView } from "./views/SearchView";
import { TopicsView } from "./views/TopicsView";
import { TopicView } from "./views/TopicView";
import "./styles.css";

initTheme();

function Layout() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const isDaily = location.pathname === "/";
  const date = params.get("date") ?? todayISO();

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <SearchBar />
          {isDaily && (
            <DatePicker
              date={date}
              onChange={(d) => setParams(d === todayISO() ? {} : { date: d })}
            />
          )}
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginView />} />
        <Route element={<Layout />}>
          <Route path="/" element={<DailyView />} />
          <Route path="/topics" element={<TopicsView />} />
          <Route path="/topic/:slug" element={<TopicView />} />
          <Route path="/search" element={<SearchView />} />
          <Route path="/admin" element={<AdminView />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
