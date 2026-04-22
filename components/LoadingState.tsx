'use client';

import { useEffect, useState } from 'react';

const STAGES = [
  'Standardising address…',
  'Fetching recent comparable sales…',
  'Pulling suburb market context…',
  'Indexing sales and computing fair value…',
  'Assessing vendor motivation…',
  'Running the max-price framework…',
  'Composing the narrative…',
];

export function LoadingState() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStage((s) => (s + 1) % STAGES.length);
    }, 1400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center text-center py-12">
      <div className="h-12 w-12 border-4 border-navy border-t-transparent rounded-full animate-spin mb-4" />
      <p className="text-navy font-medium">Generating your CMA</p>
      <p className="text-sm text-slate-500 mt-1 transition-opacity">
        {STAGES[stage]}
      </p>
    </div>
  );
}
