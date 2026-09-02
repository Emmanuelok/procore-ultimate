/**
 * Money entry for the budget workspace.
 *
 * The design system's CurrencyInput stores MINOR units (cents, pence, fils) so
 * a typed figure never passes through a float. The budget API speaks major
 * units, so the conversion happens exactly here — once, with the currency's own
 * exponent (JPY has none, KWD has three) rather than a hard-coded ×100.
 */
import { forwardRef } from "react";
import { CurrencyInput, currencyExponent } from "../../ui/inputs";

export function majorToMinor(major: number | null | undefined, currency: string): number | null {
  if (major === null || major === undefined || !Number.isFinite(major)) return null;
  const factor = 10 ** currencyExponent(currency);
  return Math.round(major * factor);
}

export function minorToMajor(minor: number | null | undefined, currency: string): number | null {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return null;
  const factor = 10 ** currencyExponent(currency);
  return minor / factor;
}

export interface MoneyFieldProps {
  value: number | null;
  onChange: (next: number | null) => void;
  currency: string;
  allowNegative?: boolean;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** A money field denominated in major units, in ONE currency. */
export const MoneyField = forwardRef<HTMLInputElement, MoneyFieldProps>(function MoneyField(
  { value, onChange, currency, allowNegative = false, ...rest },
  ref,
) {
  return (
    <CurrencyInput
      ref={ref}
      currency={currency}
      allowNegative={allowNegative}
      showCode
      value={majorToMinor(value, currency)}
      onChange={(minor) => onChange(minorToMajor(minor, currency))}
      {...rest}
    />
  );
});
