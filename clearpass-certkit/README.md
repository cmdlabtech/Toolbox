# ClearPass CertKit Setup Notes

<p align="left">
  <a href="../README.md"><img src="https://img.shields.io/badge/Toolbox-cmdlabtech-181717?style=flat-square&logo=github" alt="Toolbox"/></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-0A7B3E?style=flat-square" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/Type-Ops%20guide-555?style=flat-square" alt="Ops guide"/>
  <img src="https://img.shields.io/badge/ClearPass-Certificates-00ADEF?style=flat-square" alt="ClearPass"/>
  <a href="https://www.paypal.com/donate/?business=8E4EWZ3QJ3CML&no_recurring=0&currency_code=USD"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?style=flat-square&logo=paypal&logoColor=white" alt="Donate"/></a>
</p>

<p align="center">
  <a href="../README.md"><img src="../branding/cmdlab-wordmark.png" alt="CMDLAB" width="280"/></a>
</p>


> **Part of [Toolbox](../README.md)** — open network utilities by **CMDLAB** / [cmdlabtech](https://github.com/cmdlabtech).

Ops checklist for using **CertKit** (or a similar ACME/agent workflow) to create and deploy TLS certificates onto **ClearPass Policy Manager** via the ClearPass REST API.

This folder is **documentation** plus the public **ISRG Root X1** trust anchor PEM — not a runnable installer.

---

## Files

| File | Purpose |
|------|---------|
| [`setup-notes.txt`](setup-notes.txt) | Step-by-step ClearPass + CertKit configuration notes |
| [`Root X1 Cert.pem`](Root%20X1%20Cert.pem) | ISRG Root X1 (`CN=ISRG Root X1,O=Internet Security Research Group,C=US`) for the ClearPass trust list when using Let's Encrypt–style chains |

---

## High-level flow

### 1. ClearPass operator profile + API client

1. Create a **Guest / Operator profile** (example name: `Certificate Manager`) with:
   - **API Services** — allow API access (custom as needed)
   - **Platform → Import Configuration** — Read Only (if your workflow needs it)
   - **Policy Manager → Certificates** — Read, Write
2. Create an **API client**:
   - Operating mode: **ClearPass REST API**
   - Operator profile: the profile above
   - Grant type: **`client_credentials`**
   - Note the **client ID** and **client secret**

### 2. Trust the public CA root

Add **ISRG Root X1** to the ClearPass trust list if your issued chain depends on it. You can import [`Root X1 Cert.pem`](Root%20X1%20Cert.pem) from this folder.

### 3. CertKit (or agent) deployment

Typical CertKit-side steps (names vary by product version):

1. Create the certificate in CertKit  
2. Add an agent / deployment target for ClearPass  
3. Deploy using a **ClearPass** deployment template  
4. Configure:
   - Certificate chosen earlier  
   - ClearPass hostname (FQDN)  
   - API client ID and secret  
   - Optional deploy window  
5. Save and deploy  

See [`setup-notes.txt`](setup-notes.txt) for the condensed checklist.

---

## Security

- Treat API client secrets like admin passwords; do not commit them to git.
- Scope the operator profile to certificate (and required API) operations only.
- The Root X1 PEM here is a **public** CA certificate, not a private key.

See also [Toolbox SECURITY.md](../SECURITY.md).

---

## Related

- Browser bulk endpoint import: [ClearPass Endpoint Console](../clearpass-endpoint-console/)
- ClearPass API docs on your appliance: `https://<cppm-fqdn>/api-docs`

---

## Support

If these notes saved you a certificate renewal scramble, consider supporting continued Toolbox development:

[![Donate with PayPal](https://img.shields.io/badge/Donate_with-PayPal-00457C?style=for-the-badge&logo=paypal&logoColor=white)](https://www.paypal.com/donate/?business=8E4EWZ3QJ3CML&no_recurring=0&currency_code=USD)

## License

MIT — see the [Toolbox LICENSE](../LICENSE). The ISRG Root X1 certificate is published by the Internet Security Research Group for public use as a trust anchor.

---

<p align="center">
  <sub>
    <a href="../README.md">Toolbox</a>
    · <a href="../clearpass-endpoint-console/">Endpoint console</a>
    · <a href="../SECURITY.md">Security</a>
    · <a href="https://www.paypal.com/donate/?business=8E4EWZ3QJ3CML&no_recurring=0&currency_code=USD">Donate</a>
    · <a href="https://github.com/cmdlabtech">CMDLAB</a>
  </sub>
</p>
