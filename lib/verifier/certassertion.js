/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const
http = require("http"),
https = require("https"),
url = require("url"),
jwk = require("jwcrypto/jwk"),
jwt = require("jwcrypto/jwt"),
jwcert = require("jwcrypto/jwcert"),
vep = require("jwcrypto/vep"),
config = require("../configuration.js"),
logger = require("../logging.js").logger,
secrets = require('../secrets.js'),
primary = require('../primary.js'),
urlparse = require('urlparse');

try {
  const publicKey = secrets.loadPublicKey();
  if (typeof publicKey !== 'object') throw "secrets.loadPublicKey() returns non-object, load failure";
} catch(e){
  logger.error("can't read public key, exiting: " + e);
  setTimeout(function() { process.exit(1); }, 0);
}

const HOSTNAME = urlparse(config.get('public_url')).host;

logger.debug("This verifier will accept assertions issued by " + HOSTNAME);

// compare two audiences:
//   *want* is what was extracted from the assertion (it's trusted, we
//   generated it!
//   *got* is what was provided by the RP, so depending on their implementation
//   it might be strangely formed.
function compareAudiences(want, got) {
  function normalizeParsedURL(u) {
    if (!u.port) u.port = u.protocol === 'https:' ? 443 : 80;
    return u;
  }

  try {
    var got_scheme, got_domain, got_port;

    // We allow the RP to provide audience in multiple forms (see issue #82).
    // The RP SHOULD provide full origin, but we allow these alternate forms for
    // some dude named Postel doesn't go postal.
    // 1. full origin 'http://rp.tld'
    // 1a. full origin with port 'http://rp.tld:8080'
    // 2. domain and port 'rp.tld:8080'
    // 3. domain only 'rp.tld'

    // case 1 & 1a
    if (/^https?:\/\//.test(got)) {
      var gu = normalizeParsedURL(url.parse(got));
      got_scheme = gu.protocol;
      got_domain = gu.hostname;
      got_port = gu.port;
    }
    // case 2
    else if (got.indexOf(':') != -1) {
      var p = got.split(':');
      if (p.length !== 2) throw "malformed domain";
      got_domain = p[0];
      got_port = p[1];
    }
    // case 3
    else {
      got_domain = got;
    }

    // now parse "want" url
    want = normalizeParsedURL(url.parse(want));

    // compare the parts explicitly provided by the client
    if (got_scheme && got_scheme != want.protocol) throw "scheme mismatch"
    if (got_port && got_port != want.port) throw "port mismatch"
    if (got_domain && got_domain != want.hostname) throw "domain mismatch"

    return undefined;
  } catch(e) {
    return e.toString();
  }
}

// verify the tuple certList, assertion, audience
//
// assertion is a bundle of the underlying assertion and the cert list
// audience is a web origin, e.g. https://foo.com or http://foo.org:81
function verify(assertion, audience, successCB, errorCB) {
  // assertion is bundle
  try {
    var bundle = vep.unbundleCertsAndAssertion(assertion);
  } catch(e) {
    return errorCB("malformed assertion");
  }

  var ultimateIssuer;

  jwcert.JWCert.verifyChain(
    bundle.certificates,
    new Date(), function(issuer, next) {
      // update issuer with each issuer in the chain, so the
      // returned issuer will be the last cert in the chain
      ultimateIssuer = issuer;

      // allow other retrievers for testing
      if (issuer === HOSTNAME) return next(publicKey);
      else if (config.get('disable_primary_support')) {
        return errorCB("this verifier doesn't respect certs issued from domains other than: " +
                       HOSTNAME);
      }

      // XXX: this network work happening inside a compute process.
      // if we have a large number of requests to auth assertions that require
      // keyfetch, this could theoretically hurt our throughput.  We could
      // move the fetch up into the browserid process and pass it into the
      // compute process at some point.

      // let's go fetch the public key for this host
      primary.getPublicKey(issuer, function(err, pubKey) {
        if (err) return errorCB(err);
        next(pubKey);
      });
    }, function(pk, principal) {
      var tok = new jwt.JWT();
      tok.parse(bundle.assertion);

      // audience must match!
      var err = compareAudiences(tok.audience, audience)
      if (err) {
        logger.debug("verification failure, audience mismatch: '"
                     + tok.audience + "' != '" + audience + "': " + err);
        return errorCB("audience mismatch: " + err);
      }

      // verify that the issuer is the same as the email domain
      // NOTE: for "delegation of authority" support we'll need to make this check
      // more sophisticated
      var domainFromEmail = principal.email.replace(/^.*@/, '');
      if (ultimateIssuer != HOSTNAME && ultimateIssuer !== domainFromEmail)
      {
        return errorCB("issuer issue '" + ultimateIssuer + "' may not speak for emails from '"
                       + domainFromEmail + "'");
      }

      if (tok.verify(pk)) {
        successCB(principal.email, tok.audience, tok.expires, ultimateIssuer);
      } else {
        errorCB("verification failure");
      }
    }, errorCB);
};

exports.verify = verify;
