import { useEffect, useRef } from 'react';

import type { BindingArrayDependencies, BindingDependencies, NamedBindingDependencies } from '../binding/types/binding-dependencies';
import type { ChangeListenerRemover } from '../binding/types/change-listener';
import type { InferBindingValueTypes } from '../binding/types/infer-binding-value-types';
import type { ReadonlyBinding } from '../binding/types/readonly-binding';
import { isBinding } from '../binding-utils/type-utils.js';
import { areEqual } from '../config/are-equal.js';
import { normalizeAsArray } from '../internal-utils/array-like.js';
import { extractBindingDependencyValues } from '../internal-utils/extract-binding-dependency-values.js';
import { getTypedKeys } from '../internal-utils/get-typed-keys.js';
import { pickLimiterOptions } from '../limiter/pick-limiter-options.js';
import { useLimiter } from '../limiter/use-limiter.js';
import type { EmptyObject } from '../types/empty';
import { useCallbackRef } from '../utility-hooks/use-callback-ref.js';
import { useStableValue } from '../utility-hooks/use-stable-value.js';
import type { UseBindingEffectOptions } from './types/options';

const emptyDependencies = Object.freeze({} as EmptyObject);

/**
 * Called when the associated bindings change, depending on the options provided to `useBindingEffect`.
 *
 * @param bindingValues - The extracted values of the associated named bindings.  If named bindings aren't used, this will be an empty
 * object.
 * @param bindings - The original named bindings if named bindings are used or an empty object otherwise.
 */
export type UseBindingEffectCallback<DependenciesT extends BindingDependencies> = (
  bindingValues: InferBindingValueTypes<DependenciesT>,
  bindings: DependenciesT
) => void;

/**
 * Calls the specified callback function any time any of the specified bindings are changed.
 *
 * Most of the time you should use this hook rather than addChangeListener.
 *
 * @returns a function that can be called anytime to cancel the most recent limited callback.  This is useful, for example, if the the
 * callback would have triggered a re-render that we, by other means, know to be unnecessary.
 */
export const useBindingEffect = <DependenciesT extends BindingDependencies>(
  bindings: DependenciesT | undefined,
  callback: UseBindingEffectCallback<DependenciesT>,
  options: UseBindingEffectOptions = {}
): (() => void) => {
  const {
    id,
    deps,
    areInputValuesEqual = areEqual,
    detectInputChanges = false,
    makeComparableInputValue,
    triggerOnMount = 'if-input-changed'
  } = options;

  const limiterOptions = pickLimiterOptions(options);

  const isNonNamedBindings = Array.isArray(bindings) || isBinding(bindings);
  const nonNamedBindings = isNonNamedBindings ? (bindings as ReadonlyBinding | BindingArrayDependencies) : undefined;
  const namedBindings = isNonNamedBindings ? undefined : (bindings as NamedBindingDependencies);
  const namedBindingsKeys = namedBindings !== undefined ? getTypedKeys(namedBindings) : undefined;
  const stableAllBindings = useStableValue(
    isNonNamedBindings ? normalizeAsArray(nonNamedBindings) : Object.values(namedBindings ?? emptyDependencies)
  );

  // Doesn't need to be stable since always used in a callback ref
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  const getDependencyValues = () => extractBindingDependencyValues<DependenciesT>({ bindings, namedBindingsKeys });

  const comparableInputValueMaker = makeComparableInputValue ?? getDependencyValues;
  const lastComparableInputValue = useRef(
    detectInputChanges && (triggerOnMount === false || triggerOnMount === 'if-input-changed') ? comparableInputValueMaker() : undefined
  );

  /** Only used when `detectInputChanges` is `false` and `triggerOnMount` is `'if-input-changed'` */
  const lastChangeUids = useRef<string | undefined>(undefined);

  const limiter = useLimiter({
    id: id ?? 'use-binding-effect',
    cancelOnUnmount: true,
    ...limiterOptions
  });

  const checkAndUpdateIfInputChanged = useCallbackRef(() => {
    if (detectInputChanges) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const nextComparableInputValue = comparableInputValueMaker!();
      if (areInputValuesEqual(lastComparableInputValue.current, nextComparableInputValue)) {
        return false;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      lastComparableInputValue.current = nextComparableInputValue;
      return true;
    } else if (triggerOnMount === 'if-input-changed') {
      const newChangeUids = makeChangeUidsString(stableAllBindings);
      if (newChangeUids === lastChangeUids.current) {
        return false;
      }

      lastChangeUids.current = newChangeUids;
      return true;
    } else {
      return true;
    }
  });

  const isFirstRender = useRef(true);
  const needsTrigger = useRef(false);

  const triggerCallback = useCallbackRef((needsInputChangeTrackingUpdate: boolean) => {
    needsTrigger.current = false;

    if (needsInputChangeTrackingUpdate) {
      // We don't care about the result here -- just want to update the tracking
      checkAndUpdateIfInputChanged();
    }

    callback(getDependencyValues(), bindings ?? (emptyDependencies as DependenciesT));
  });

  const performChecksAndTriggerCallbackIfNeeded = useCallbackRef(() => {
    if (needsTrigger.current) {
      triggerCallback(true);
    } else {
      const didChange = checkAndUpdateIfInputChanged();
      if (detectInputChanges && !didChange) {
        return; // No change
      }

      triggerCallback(false);
    }
  });

  if (isFirstRender.current) {
    isFirstRender.current = false;

    if (!detectInputChanges && triggerOnMount === 'if-input-changed') {
      lastChangeUids.current = makeChangeUidsString(stableAllBindings);
    }
  }

  useEffect(() => {
    const addedBindingUids = new Set<string>();
    const removers: ChangeListenerRemover[] = [];
    for (const b of stableAllBindings) {
      if (b !== undefined && !addedBindingUids.has(b.uid)) {
        // Making sure we only listen for changes once per binding, even if the same binding is listed multiple times
        addedBindingUids.add(b.uid);

        removers.push(b.addChangeListener(() => limiter.limit(performChecksAndTriggerCallbackIfNeeded)));
      }
    }

    return () => {
      for (const remover of removers) {
        remover();
      }
      removers.length = 0;
    };
  }, [limiter, performChecksAndTriggerCallbackIfNeeded, stableAllBindings]);

  const isFirstMount = useRef(true);
  useEffect(() => {
    if (
      needsTrigger.current ||
      triggerOnMount === true ||
      (isFirstMount.current && triggerOnMount === 'first') ||
      (triggerOnMount === 'if-input-changed' && checkAndUpdateIfInputChanged())
    ) {
      needsTrigger.current = true;
      limiter.limit(() => triggerCallback(true));
    }
    isFirstMount.current = false;
  });

  // If the deps changed,
  const lastDepsValue = useRef(deps);
  if (!areEqual(lastDepsValue.current, deps)) {
    lastDepsValue.current = deps;

    needsTrigger.current = true;
    limiter.limit(() => triggerCallback(true));
  }

  // If the upcoming callback is canceled, it's assumed we have already dealt with the input in a different way, so we need to update the
  // tracking info to make sure we don't reprocess the same thing later
  return () => {
    limiter.cancel();
    needsTrigger.current = false;
    // We don't care about the result here -- just want to update the tracking
    checkAndUpdateIfInputChanged();
  };
};

// Helpers

const makeChangeUidsString = (bindings: Array<ReadonlyBinding | undefined>) => {
  const array: string[] = [];
  for (const b of bindings) {
    array.push(b?.getChangeUid() ?? '');
  }
  return array.join(',');
};
