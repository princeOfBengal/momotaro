/**
 * Wraps an async route handler so errors are forwarded to Express error middleware.
 */
function asyncWrapper(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncWrapper };
