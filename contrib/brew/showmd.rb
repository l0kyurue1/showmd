require "language/node"

class Showmd < Formula
  desc "Read and edit markdown in your browser"
  homepage "https://github.com/l0kyurue1/showmd"
  url "https://registry.npmjs.org/showmd-cli/-/showmd-cli-0.1.3.tgz"
  sha256 "5c50a716e7d70d070edae107444358ba041e586e91384ec9470ee527b04fcbe8"
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
