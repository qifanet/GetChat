/**
 * @file ParallelForkReviewPanel.tsx
 * @description Proposal review panel for parallel branch fork (v1.5.0)
 */

import { useState } from 'react';
import { executeParallelFork } from '../../services/tauriCommands';
import type { ProposalBranchDto } from '../../services/tauriTypes';
import { useAppStore } from '../../stores/useAppStoreSelector';

interface ParallelForkReviewPanelProps {
  proposalId: string;
  branches: ProposalBranchDto[];
  onExecute: (taskIds: string[]) => void;
  onError: (error: Error) => void;
}

const _sel_providerModels = (s: import("../../stores/appStore.types").AppStore) => s.providerModels;

export function ParallelForkReviewPanel({
  proposalId,
  branches: initialBranches,
  onExecute,
  onError,
}: ParallelForkReviewPanelProps) {
  const [branches, setBranches] = useState<ProposalBranchDto[]>(initialBranches);
  const [executing, setExecuting] = useState(false);
  const [executed, setExecuted] = useState(false);
  const providerModels = useAppStore(_sel_providerModels);

  const handleBranchChange = (index: number, field: keyof ProposalBranchDto, value: string) => {
    const updated = [...branches];
    updated[index] = { ...updated[index], [field]: value };
    setBranches(updated);
  };

  const handleExecute = async () => {
    if (executing || executed) return;
    
    setExecuting(true);
    try {
      const taskIds = await executeParallelFork(proposalId, branches);
      setExecuted(true);
      onExecute(taskIds);
    } catch (error) {
      onError(error as Error);
    } finally {
      setExecuting(false);
    }
  };

  if (executed) {
    return (
      <div className="border border-green-300 dark:border-green-600 rounded-lg p-4 my-4 bg-green-50 dark:bg-green-900/20">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="text-sm font-semibold text-green-700 dark:text-green-300">
            ✓ Proposal executed — {branches.length} {branches.length === 1 ? 'branch' : 'branches'} launched
          </span>
        </div>
        <p className="text-xs text-green-600 dark:text-green-400 mt-1">
          Check Task Queue panel below for execution status.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-gray-300 dark:border-gray-600 rounded-lg p-4 my-4 bg-gray-50 dark:bg-gray-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          Review Parallel Fork Proposal
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {branches.length} {branches.length === 1 ? 'branch' : 'branches'}
        </span>
      </div>

      <div className="space-y-3">
        {branches.map((branch, index) => (
          <div
            key={index}
            className="border border-gray-200 dark:border-gray-700 rounded-md p-3 bg-white dark:bg-gray-900"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                Branch {index + 1}:
              </span>
              <input
                type="text"
                value={branch.branchName}
                onChange={(e) => handleBranchChange(index, 'branchName', e.target.value)}
                className="flex-1 text-sm font-semibold px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Branch name"
              />
            </div>

            <textarea
              value={branch.initialMessage}
              onChange={(e) => handleBranchChange(index, 'initialMessage', e.target.value)}
              rows={3}
              className="w-full text-sm px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Initial message for this branch"
            />

            <div className="mt-2">
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Model (optional):
              </label>
              <select
                value={branch.modelId}
                onChange={(e) => handleBranchChange(index, 'modelId', e.target.value)}
                className="w-full text-sm px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Use default model</option>
                {Object.values(providerModels).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={handleExecute}
          disabled={executing}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-md transition-colors"
        >
          {executing ? 'Launching...' : 'Launch All Branches'}
        </button>
      </div>
    </div>
  );
}
