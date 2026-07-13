// Attempts to mutate the (now-cached-across-tasks) workerOptions object,
// including a NESTED property, to verify deep-freeze prevents any mutation
// from leaking into subsequent files in the same stream (regression test for
// the deep-freeze review fix).
exports.init = async () => 'Init OK';
exports.process = async (contentStr, filename, sourceMapFlag, workerOptions) => {
  let topLevelThrew = false;
  let nestedThrew = false;

  try {
    workerOptions.suffix = 'HACKED';
  } catch {
    topLevelThrew = true;
  }

  try {
    workerOptions.nested.list.push('polluted');
  } catch {
    nestedThrew = true;
  }

  return {
    result: JSON.stringify({
      suffix: workerOptions.suffix,
      listLength: workerOptions.nested.list.length,
      topLevelThrew,
      nestedThrew
    })
  };
};
