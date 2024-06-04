# Exact XML Uploader

This is a simple tool to upload XML files to Exact Online (uses the XML Import functionality). It is written in Typescript and uses Puppeteer.

## Usage

```bash
npx env-cmd -f .env -- npm run upload -- ../folder-with-xmls --otp 123456
```

You need to make some of these environment variables available:

```
EXACT_DIVISION="123456" # you can find this in the url of Exact Online after logging in
# Auto login mode
USERNAME="Username" # your username
PASSWORD="Password" # your password
OTP_URI="otpauth://totp/SECRET" # to auto-generate OTP code
# Manual login mode
LOGIN_MODE=manual # if logging in through external URL
LOGIN_URL="https://start.exactonline.be/sso?connection=PROVIDER&_Division_=123456" # URL to log in
```

After upload, you can find error logs and screenshots in the `tmp` folder.

If you just want to login:

```bash
npx env-cmd -f .env -- npm run login
```

## Troubleshooting

#### `Topic [GLTransactions] Property 'VATCode' of business component 'GLTransactionVATLine' is mandatory.`

This means the VAT code doesn't exist in Exact Online.

#### `Topic [GLTransactions] Not allowed: Currency`

The journal doesn't support the currency.