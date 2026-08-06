import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";

export function LoginView() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid password" : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>app-daybook</h1>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={busy || password === ""}>
          {busy ? "…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
