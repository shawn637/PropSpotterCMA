'use client';

import { FormEvent, useState } from 'react';

import type { CMARequest } from '@/lib/types';

interface AddressFormProps {
  onSubmit: (req: CMARequest) => void;
  disabled?: boolean;
}

export function AddressForm({ onSubmit, disabled }: AddressFormProps) {
  const [address, setAddress] = useState('');
  const [listingDescription, setListingDescription] = useState('');
  const [daysOnMarket, setDaysOnMarket] = useState('');

  const canSubmit = address.trim().length >= 8 && !disabled;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const dom = daysOnMarket.trim() ? Number(daysOnMarket) : undefined;
    onSubmit({
      address: address.trim(),
      listingDescription: listingDescription.trim() || undefined,
      actualDaysOnMarket:
        typeof dom === 'number' && Number.isFinite(dom) && dom > 0 ? dom : undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="address"
          className="block text-sm font-medium text-navy mb-1"
        >
          Property address
        </label>
        <input
          id="address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="e.g. 42 Example Street, Baulkham Hills NSW 2153"
          className="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
          disabled={disabled}
          required
        />
        <p className="text-xs text-slate-500 mt-1">
          Enter a full Australian property address.
        </p>
      </div>

      <div>
        <label
          htmlFor="listing"
          className="block text-sm font-medium text-navy mb-1"
        >
          Listing description <span className="text-slate-400">(optional)</span>
        </label>
        <textarea
          id="listing"
          value={listingDescription}
          onChange={(e) => setListingDescription(e.target.value)}
          placeholder="Paste the agent's listing copy to improve vendor-motivation detection."
          className="w-full rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy min-h-[96px]"
          disabled={disabled}
        />
      </div>

      <div>
        <label
          htmlFor="dom"
          className="block text-sm font-medium text-navy mb-1"
        >
          Actual days on market <span className="text-slate-400">(optional)</span>
        </label>
        <input
          id="dom"
          type="number"
          min={1}
          value={daysOnMarket}
          onChange={(e) => setDaysOnMarket(e.target.value)}
          placeholder="e.g. 19"
          className="w-48 rounded-md border border-slate-300 px-3 py-2 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy"
          disabled={disabled}
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex items-center justify-center rounded-md bg-navy px-5 py-2.5 text-white font-medium hover:bg-navy/90 disabled:bg-slate-300 disabled:cursor-not-allowed"
      >
        Generate CMA
      </button>
    </form>
  );
}
