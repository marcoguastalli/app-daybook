interface DatePickerProps {
  date: string; // YYYY-MM-DD
  onChange: (date: string) => void;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

export function DatePicker({ date, onChange }: DatePickerProps) {
  return (
    <div className="datepicker">
      <button type="button" className="ghost" aria-label="Previous day" onClick={() => onChange(shiftDate(date, -1))}>
        ←
      </button>
      <input
        type="date"
        value={date}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
      <button type="button" className="ghost" aria-label="Next day" onClick={() => onChange(shiftDate(date, 1))}>
        →
      </button>
    </div>
  );
}
