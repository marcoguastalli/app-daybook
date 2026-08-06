import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

export function SearchBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [value, setValue] = useState("");

  // Landing on /search?q=… (deep link, back button) reflects into the field.
  useEffect(() => {
    if (location.pathname === "/search") setValue(params.get("q") ?? "");
  }, [location.pathname, params]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (q !== "") navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <form className="searchbar-form" onSubmit={submit}>
      <input
        className="searchbar"
        type="search"
        placeholder='Search all topics and entries — supports "exact phrase", -exclude, OR'
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
