require "language/node"

class Showmd < Formula
  desc "Read and edit markdown in your browser"
  homepage "https://github.com/l0kyurue1/showmd"
  url "https://registry.npmjs.org/showmd-cli/-/showmd-cli-0.2.1.tgz"
  sha256 "349ba9af680cb9cfc3bb855f8ddf5aab6dfc66a54859ee8bbf4c2e822cc6f9ca"
  license "MIT"

  depends_on "node"

  livecheck do
    url "https://registry.npmjs.org/showmd-cli/latest"
    strategy :json do |json|
      json["version"]
    end
  end

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/showmd --version")
  end
end
